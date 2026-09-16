import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoCall, TelephonyCall } from "@msva/shared";
import type { WebSocket } from "ws";
import type { AsrEvent } from "./asr/index.js";
import { startFrame, inboundMediaFrame } from "./exotel.js";

const GREETING = "Namaste, main Madhusudan ki AI assistant hoon. Kaise madad kar sakti hoon?";
const RETRY = "Maaf kijiye, aapki baat sun nahi paayi. Dobara kahiye.";
const profile: DemoCall = { id: "test", callerName: "Caller", phone: "9000000000", callerType: "customer", intent: "unknown", language: "hinglish", urgency: "low", transcriptSeed: "test", expectedOutcome: "resolved_by_va" };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function harness(kind: "browser" | "exotel") {
  const messages: unknown[] = [];
  const ws = { OPEN: 1, readyState: 1, send: (data: string | Buffer) => messages.push(typeof data === "string" ? JSON.parse(data) : data) } as unknown as WebSocket;
  const feed = vi.fn(async (_pcm: Buffer) => {});
  let emit: (event: AsrEvent) => void = () => { throw new Error("ASR not started"); };
  vi.doMock("./asr/sarvam.js", () => ({ createSarvamAsr: () => {
    const events: AsrEvent[] = [];
    let next: ((result: IteratorResult<AsrEvent>) => void) | undefined;
    let closed = false;
    emit = event => { if (next) { const resolve = next; next = undefined; resolve({ value: event, done: false }); } else events.push(event); };
    return { feed, endpoint: vi.fn(), close: async () => { closed = true; next?.({ value: undefined, done: true }); },
      events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => events.length
        ? Promise.resolve({ value: events.shift()!, done: false })
        : closed ? Promise.resolve({ value: undefined, done: true }) : new Promise(resolve => { next = resolve; }) }) }) };
  } }));
  const spoken: string[] = [];
  vi.doMock("./tts/sarvam.js", () => ({ createSarvamTts: () => {
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    let cancelled = false;
    return { push: (text: string) => spoken.push(text), end: () => resolve(), cancel: () => { cancelled = true; resolve(); },
      chunks: async function* () { await done; if (!cancelled) yield { pcm: Buffer.from([1, 0]), isFinal: true }; } };
  } }));
  vi.doMock("./tts/promptCache.js", () => ({ lookupPrompt: () => null, createBufferTts: vi.fn() }));
  const callLog = { start: vi.fn(async () => {}), turn: vi.fn(async () => {}), end: vi.fn(async () => {}) };
  vi.doMock("./callLog.js", () => ({ callLog }));
  let release!: () => void;
  let hold = false;
  const held = new Promise<void>(r => { release = r; });
  const streamAgent = vi.fn(async function* (_callId: string, text: string) {
    yield { type: "token", text: `Reply to ${text}` };
    if (hold) { hold = false; await held; }
  });
  vi.doMock("./agentClient.js", () => ({ streamAgent }));
  let close: () => Promise<void>;
  let audio: (pcm: Buffer) => Promise<void>;
  let providerCall: TelephonyCall | undefined;
  if (kind === "browser") {
    const { createBrowserPipeline } = await import("./browserPipeline.js");
    const pipeline = createBrowserPipeline(ws, profile, "test");
    pipeline.handleText({ type: "start" });
    close = () => pipeline.close();
    audio = pcm => pipeline.handleAudio(pcm);
  } else {
    const { createCallPipeline } = await import("./pipeline.js");
    providerCall = { callSid: "temporary-socket-id", provider: "exotel", fromNumber: "", toNumber: "", startedAt: new Date().toISOString(), profile };
    const pipeline = createCallPipeline(ws, providerCall);
    await pipeline.handleInbound(startFrame({ streamSid: "stream", callSid: "real-provider-id", accountSid: "synthetic-account", from: "+919000000000", to: "+910000000000", sampleRate: 8000 }));
    close = () => pipeline.close();
    audio = pcm => pipeline.handleInbound(inboundMediaFrame("stream", pcm, 2, 0));
  }
  await settle();
  return { emit, spoken, messages, feed, audio, callLog, streamAgent, close, providerCall, hold: () => { hold = true; }, release };
}

beforeEach(() => { vi.resetModules(); vi.stubEnv("CALL_GREETING", ""); vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

for (const kind of ["browser", "exotel"] as const) describe(`${kind} caller turn safety`, () => {
  it("uses the same short fixed greeting without opening a business turn", async () => {
    const h = await harness(kind);
    expect(h.spoken).toEqual([GREETING]);
    expect(h.streamAgent).not.toHaveBeenCalled();
    await h.close();
  });

  it("speaks one honest retry on recognition failure with no caller transcript or business turn", async () => {
    const h = await harness(kind);
    h.streamAgent.mockClear(); h.spoken.length = 0; h.callLog.turn.mockClear(); h.messages.length = 0;
    h.emit({ type: "error", code: "recognition_failed", retryable: true, message: "unavailable" });
    h.emit({ type: "error", code: "recognition_failed", retryable: true, message: "unavailable" });
    await settle();
    expect(h.spoken).toEqual([RETRY]);
    expect(h.streamAgent).not.toHaveBeenCalled();
    expect(h.callLog.turn).toHaveBeenCalledTimes(1);
    expect(h.callLog.turn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      callerText: null, replyText: RETRY, source: "asr_error", toolCalls: []
    }));
    expect(h.messages.filter((m: any) => m.type === "user_transcript")).toEqual([]);
    await h.close();
  });

  it("preserves a caller final arriving while the previous turn is still running", async () => {
    const h = await harness(kind);
    h.streamAgent.mockClear(); h.hold();
    h.emit({ type: "final", text: "first question", confidence: 0.9, durationMs: 500 });
    await settle();
    h.emit({ type: "final", text: "important correction", confidence: 0.9, durationMs: 500 });
    await settle();
    expect(h.streamAgent.mock.calls.map(args => args[1])).toEqual(["first question"]);
    h.release();
    await settle();
    expect(h.streamAgent.mock.calls.map(args => args[1])).toEqual(["first question", "important correction"]);
    await h.close();
  });

  it("clears an obsolete recognition retry when a valid repetition is accepted", async () => {
    const h = await harness(kind);
    h.streamAgent.mockClear(); h.spoken.length = 0; h.hold();
    h.emit({ type: "final", text: "first question", confidence: 0.9, durationMs: 500 });
    await settle();
    h.emit({ type: "error", code: "recognition_failed", retryable: true, message: "unavailable" });
    h.emit({ type: "final", text: "successful repetition", confidence: 0.9, durationMs: 500 });
    await settle();
    h.release();
    await settle();
    expect(h.streamAgent.mock.calls.map(args => args[1])).toEqual(["first question", "successful repetition"]);
    expect(h.spoken).not.toContain(RETRY);
    expect(h.callLog.turn.mock.calls.some(args => args[1]?.source === "asr_error")).toBe(false);
    await h.close();
  });

  it("retains the beginning of caller speech that triggers barge-in", async () => {
    const h = await harness(kind);
    h.hold();
    h.emit({ type: "final", text: "first", confidence: 0.9, durationMs: 500 });
    await settle();
    const sampleRate = kind === "browser" ? 16000 : 8000;
    const frames = [150, 300, 100].map(ms => {
      const frame = Buffer.alloc(sampleRate * 2 * ms / 1000);
      for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(1500, i);
      return frame;
    });
    for (const frame of frames) await h.audio(frame);
    expect(Buffer.concat(h.feed.mock.calls.map(args => args[0])).equals(Buffer.concat(frames))).toBe(true);
    h.release(); await settle(); await h.close();
  });

  it("bounds queued caller turns and asks for repetition if they overflow", async () => {
    const h = await harness(kind);
    h.streamAgent.mockClear(); h.spoken.length = 0; h.hold();
    h.emit({ type: "final", text: "first", confidence: 0.9, durationMs: 500 });
    await settle();
    for (let i = 1; i <= 5; i++) h.emit({ type: "final", text: `follow-up ${i}`, confidence: 0.9, durationMs: 500 });
    await settle(); h.release();
    await vi.waitFor(() => expect(h.spoken).toContain(RETRY));
    expect(h.streamAgent.mock.calls.map(args => args[1])).toEqual(["first", "follow-up 1", "follow-up 2", "follow-up 3"]);
    expect(h.spoken.filter(text => text === RETRY)).toHaveLength(1);
    await h.close();
  });

  it("drops queued work on hangup and emits no late playback", async () => {
    const h = await harness(kind);
    h.streamAgent.mockClear(); h.hold();
    h.emit({ type: "final", text: "first", confidence: 0.9, durationMs: 500 });
    await settle();
    h.emit({ type: "final", text: "queued", confidence: 0.9, durationMs: 500 });
    await settle();
    await h.close();
    h.messages.length = 0;
    h.release(); await settle();
    expect(h.streamAgent.mock.calls.map(args => args[1])).toEqual(["first"]);
    expect(h.messages).toEqual([]);
  });
});

it("uses the provider SID from the start frame for call and turn persistence", async () => {
  const h = await harness("exotel");
  expect(h.providerCall?.callSid).toBe("real-provider-id");
  expect(h.callLog.start).toHaveBeenCalledWith(expect.objectContaining({ id: "real-provider-id", providerSid: "real-provider-id" }));
  h.emit({ type: "final", text: "hello", confidence: 0.9, durationMs: 500 });
  await settle();
  expect(h.streamAgent).toHaveBeenCalledWith("real-provider-id", "hello", expect.anything(), "real-provider-id");
  await h.close();
});
