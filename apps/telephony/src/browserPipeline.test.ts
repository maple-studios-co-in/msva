import { startFrame, inboundMediaFrame } from "./exotel.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DemoCall } from "@msva/shared";
import type { WebSocket } from "ws";
const profile: DemoCall = { id: "browser-live", callerName: "Browser caller", phone: "", callerType: "unknown", intent: "unknown", language: "hinglish", urgency: "low", transcriptSeed: "", expectedOutcome: "resolved_by_va" };
beforeEach(() => { vi.resetModules(); vi.stubEnv("SARVAM_API_KEY", "test-provider-key"); vi.stubEnv("PROMPT_AUDIO_DIR", "/tmp/msva-empty-test-prompt-cache"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("sends the actual browser profile and greeting on the first recognized caller turn", async () => {
  const agentRequests: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    if (path.includes("/api/internal/")) return Response.json({ ok: true });
    if (path === "/text-to-speech/stream") return new Response(new Uint8Array([1, 0]));
    if (path === "/speech-to-text") return Response.json({ transcript: "Hello, madad chahiye" });
    if (path === "/api/voice-agent/chat/stream") {
      const body = JSON.parse(init.body); agentRequests.push(body);
      return new Response('data: {"type":"token","text":"Kaise madad kar sakti hoon?"}\n\n');
    }
    throw new Error(`Unexpected provider endpoint: ${path}`);
  }));
  const messages: any[] = [];
  const ws = { OPEN: 1, readyState: 1, send(data: string | Buffer) { if (typeof data === "string") messages.push(JSON.parse(data)); } } as unknown as WebSocket;
  const { createBrowserPipeline } = await import("./browserPipeline.js");
  const pipeline = createBrowserPipeline(ws, profile, "browser-live");
  pipeline.handleText({ type: "start" });
  await vi.waitFor(() => expect(messages.some(m => m.type === "status" && m.state === "listening")).toBe(true));
  const speech = Buffer.alloc(16_000);
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(1500, i);
  await pipeline.handleAudio(speech);
  await pipeline.handleAudio(Buffer.alloc(32_000));
  await vi.waitFor(() => expect(agentRequests).toHaveLength(1));
  expect(agentRequests[0].state).toMatchObject({ call: profile, outcome: "in_progress", collected: {} });
  expect(agentRequests[0].state.messages).toEqual([expect.objectContaining({ role: "assistant", text: "Namaste, main Madhusudan ki AI assistant hoon. Kaise madad kar sakti hoon?" })]);
  expect(JSON.stringify(agentRequests[0])).not.toMatch(/Rajesh|Ghaziabad|delivery_delay/);
  await pipeline.close();
});

for (const kind of ["browser", "exotel"] as const) it(`${kind}: saves the received caller turn before a stalled model and hangup`, async () => {
  const logs: { path: string; body: any }[] = [];
  let release!: () => void;
  let agentStarted = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    if (path.includes("/api/internal/")) { logs.push({ path, body: JSON.parse(init.body) }); return Response.json({ ok: true }); }
    if (path === "/text-to-speech/stream") return new Response(new Uint8Array([1, 0]));
    if (path === "/speech-to-text") return Response.json({ transcript: "Meri baat record kijiye" });
    if (path === "/api/voice-agent/chat/stream") {
      agentStarted = true;
      return new Promise<Response>(resolve => { release = () => resolve(new Response('data: {"type":"token","text":"Reply"}\n\n')); });
    }
    throw new Error(`Unexpected provider endpoint: ${path}`);
  }));
  const ws = { OPEN: 1, readyState: 1, send() {} } as unknown as WebSocket;
  let audio: (pcm: Buffer) => Promise<void>;
  let close: () => Promise<void>;
  if (kind === "browser") {
    const { createBrowserPipeline } = await import("./browserPipeline.js");
    const pipeline = createBrowserPipeline(ws, profile, "browser-live");
    pipeline.handleText({ type: "start" });
    audio = pcm => pipeline.handleAudio(pcm); close = () => pipeline.close();
  } else {
    const { createCallPipeline } = await import("./pipeline.js");
    const pipeline = createCallPipeline(ws, { callSid: "call-real", provider: "exotel", fromNumber: "", toNumber: "", startedAt: new Date().toISOString(), profile });
    await pipeline.handleInbound(startFrame({ streamSid: "stream", callSid: "call-real", accountSid: "test", from: "+919000000000", to: "", sampleRate: 8000 }));
    audio = pcm => pipeline.handleInbound(inboundMediaFrame("stream", pcm, 1, 0)); close = () => pipeline.close();
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  const rate = kind === "browser" ? 16000 : 8000;
  const speech = Buffer.alloc(rate);
  for (let i = 0; i < speech.length; i += 2) speech.writeInt16LE(1500, i);
  await audio(speech); await audio(Buffer.alloc(rate * 2));
  await vi.waitFor(() => expect(agentStarted).toBe(true));
  await close();
  await vi.waitFor(() => expect(logs.some(log => log.path.endsWith("/end"))).toBe(true));
  const savedTurn = logs.findIndex(log => log.path.endsWith("/turns"));
  const savedEnd = logs.findIndex(log => log.path.endsWith("/end"));
  expect(savedTurn).toBeGreaterThan(-1);
  expect(savedTurn).toBeLessThan(savedEnd);
  expect(logs[savedTurn]?.body).toMatchObject({ index: 1, callerText: "Meri baat record kijiye" });
  release();
  await vi.waitFor(() => expect(logs.filter(log => log.path.endsWith("/turns"))).toHaveLength(2));
  expect(logs.filter(log => log.path.endsWith("/turns")).map(log => log.body.index)).toEqual([1, 1]);
});
