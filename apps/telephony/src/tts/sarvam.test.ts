import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsChunk } from "./index.js";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SARVAM_API_KEY", "synthetic-test-key");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function adapter() {
  const { createSarvamTts } = await import("./sarvam.js");
  return createSarvamTts({ voice: "neha", sampleRate: 8000, language: "hi-IN" });
}

function streamHarness() {
  const requests: { text: string; controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { requests.push({ text: JSON.parse(init.body).text.trim(), controller, signal: init.signal }); }
  }))));
  return requests;
}

async function collect(tts: Awaited<ReturnType<typeof adapter>>, chunks: TtsChunk[]) {
  for await (const chunk of tts.chunks()) chunks.push(chunk);
}

describe("Sarvam TTS request lifecycle", () => {
  it("serializes sentences and emits final only after all ordered audio drains", async () => {
    const requests = streamHarness();
    const tts = await adapter();
    const chunks: TtsChunk[] = [];
    const playback = collect(tts, chunks);
    tts.push("A. "); tts.push("B. "); tts.push("C"); tts.end();
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests.map(r => r.text)).toEqual(["A."]);
    requests[0]!.controller.enqueue(new Uint8Array([1, 0]));
    requests[0]!.controller.close();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.controller.enqueue(new Uint8Array([2, 0]));
    requests[1]!.controller.close();
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(chunks.some(c => c.isFinal)).toBe(false);
    requests[2]!.controller.enqueue(new Uint8Array([3, 0]));
    requests[2]!.controller.close();
    await playback;
    expect(requests.map(r => r.text)).toEqual(["A.", "B.", "C"]);
    expect(Buffer.concat(chunks.map(c => c.pcm))).toEqual(Buffer.from([1, 0, 2, 0, 3, 0]));
    expect(chunks.filter(c => c.isFinal)).toHaveLength(1);
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });

  it("marks completion when end arrives after punctuation already flushed the text", async () => {
    const requests = streamHarness();
    const tts = await adapter();
    const chunks: TtsChunk[] = [];
    const playback = collect(tts, chunks);
    tts.push("Finished. "); tts.end();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0]!.controller.enqueue(new Uint8Array([1, 0]));
    requests[0]!.controller.close();
    await playback;
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });

  it("does not let a stalled provider error body block later synthesis", async () => {
    const signals: AbortSignal[] = [];
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      signals.push(init.signal);
      if (signals.length === 1) {
        // Error headers have arrived, but the provider never sends body bytes
        // or closes the body. Reading response.text() would stall the queue.
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 503 });
      }
      return new Response(new Uint8Array([2, 0]));
    }));
    const tts = await adapter();
    const chunks: TtsChunk[] = [];
    const playback = collect(tts, chunks);
    try {
      tts.push("A. "); tts.push("B"); tts.end();
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      await playback;
      expect(signals[0]!.aborted).toBe(true);
      expect(chunks.at(-1)?.isFinal).toBe(true);
      expect(chunks.some(chunk => chunk.pcm.equals(Buffer.from([2, 0])))).toBe(true);
    } finally {
      tts.cancel();
      errorLog.mockRestore();
    }
  });

  it("cancels active synthesis and never starts queued requests or emits late audio", async () => {
    const requests = streamHarness();
    const tts = await adapter();
    const chunks: TtsChunk[] = [];
    const playback = collect(tts, chunks);
    tts.push("A. "); tts.push("B. "); tts.push("C"); tts.end();
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    tts.cancel();
    // A hostile/slow transport can still resolve a read after abort.
    requests[0]!.controller.enqueue(new Uint8Array([9, 0]));
    requests[0]!.controller.close();
    await playback;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(chunks).toEqual([]);
  });
});
