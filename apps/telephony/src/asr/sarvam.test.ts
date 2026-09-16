import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sampleRate = 8000;
function pcm(seconds: number, amplitude = 1500): Buffer {
  const result = Buffer.alloc(Math.round(seconds * sampleRate) * 2);
  for (let i = 0; i < result.length; i += 2) result.writeInt16LE(amplitude, i);
  return result;
}
async function adapter() {
  const { createSarvamAsr } = await import("./sarvam.js");
  return createSarvamAsr({ language: "hi-IN", sampleRate });
}
function network() {
  const requests: { bytes: number; signal: AbortSignal; respond: () => void }[] = [];
  vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise<Response>((resolve) => {
    const file = (init.body as FormData).get("file") as Blob;
    requests.push({ bytes: file.size - 44, signal: init.signal,
      respond: () => resolve(Response.json({ transcript: `sentence ${requests.length}` })) });
  })));
  return requests;
}
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SARVAM_API_KEY", "synthetic-test-key");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Sarvam ASR audio bounds", () => {
  it("discards long idle and low-level noise before the caller starts talking", async () => {
    const requests = network();
    const asr = await adapter();
    await asr.feed(pcm(60, 100));
    const idle = asr.endpoint();
    expect(requests).toHaveLength(0);
    await idle;
    await asr.feed(pcm(0.5));
    const completed = asr.endpoint();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.bytes).toBeLessThanOrEqual(sampleRate * 2);
    requests[0]!.respond();
    await completed;
    await asr.close();
  });

  it("splits continuous speech below thirty seconds and recognizes chunks serially", async () => {
    const requests = network();
    const asr = await adapter();
    await asr.feed(pcm(62));
    const completed = asr.endpoint();
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.bytes / (sampleRate * 2)).toBeLessThan(30);
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(requests).toHaveLength(i + 1));
      expect(requests[i]!.bytes / (sampleRate * 2)).toBeLessThan(30);
      requests[i]!.respond();
    }
    await completed;
    expect(requests.reduce((sum, request) => sum + request.bytes, 0)).toBe(62 * sampleRate * 2);
    await asr.close();
  });

  it("reports backlog overload explicitly while keeping at most two waiting segments", async () => {
    const requests = network();
    const asr = await adapter();
    await asr.feed(pcm(150));
    const event = asr.events()[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(await event).toMatchObject({ value: { type: "error", code: "backlog_full" } });
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(requests).toHaveLength(i + 1));
      requests[i]!.respond();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toHaveLength(3);
    await asr.close();
  });
});

describe("Sarvam ASR failure lifecycle", () => {
  it("emits a typed error instead of fabricated caller text on provider failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporarily unavailable", { status: 503 })));
    const asr = await adapter();
    await asr.feed(pcm(0.5));
    await asr.endpoint();
    const event = await asr.events()[Symbol.asyncIterator]().next();
    expect(event.value).toMatchObject({ type: "error", code: "recognition_failed" });
    expect(event.value).not.toHaveProperty("text");
    expect(event.value).not.toHaveProperty("confidence");
    await asr.close();
  });

  it("aborts active recognition on close and suppresses late results and queued calls", async () => {
    const requests = network();
    const asr = await adapter();
    await asr.feed(pcm(0.5));
    const first = asr.endpoint();
    await asr.feed(pcm(0.5));
    const second = asr.endpoint();
    await asr.close();
    requests[0]!.respond();
    await first; await second;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(await asr.events()[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
  });
});
