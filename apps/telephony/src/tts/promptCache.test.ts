import { describe, expect, it } from "vitest";
import { createBufferTts, normalisePromptText } from "./promptCache.js";

const SAMPLE_RATE = 8000;
/** `seconds` of 16-bit mono silence at the telephone sample rate. */
const audio = (seconds: number): Buffer => Buffer.alloc(Math.round(seconds * SAMPLE_RATE) * 2);

async function drain(tts: ReturnType<typeof createBufferTts>): Promise<{ bytes: number; slices: number }> {
  let bytes = 0;
  let slices = 0;
  for await (const chunk of tts.chunks()) {
    if (chunk.isFinal) break;
    bytes += chunk.pcm.byteLength;
    slices += 1;
  }
  return { bytes, slices };
}

describe("normalisePromptText", () => {
  it("ignores case and repeated whitespace", () => {
    expect(normalisePromptText("  Namaste   JI  ")).toBe(normalisePromptText("namaste ji"));
  });

  it("still separates genuinely different lines", () => {
    expect(normalisePromptText("namaste ji")).not.toBe(normalisePromptText("namaste jee"));
  });
});

describe("createBufferTts", () => {
  it("replays every byte it was given", async () => {
    const pcm = audio(0.4);
    const { bytes } = await drain(createBufferTts(pcm, { sampleRate: SAMPLE_RATE }));
    expect(bytes).toBe(pcm.byteLength);
  });

  it("ends with a final marker", async () => {
    const chunks = [];
    for await (const chunk of createBufferTts(audio(0.1), { sampleRate: SAMPLE_RATE }).chunks()) {
      chunks.push(chunk);
      if (chunk.isFinal) break;
    }
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });

  // The reason this matters: the pipeline holds `botSpeaking` true for exactly
  // as long as the replay takes, and barge-in is only considered while the bot
  // is speaking. Emitting a whole clip instantly would mark the agent silent
  // seconds before the caller has finished hearing it, so an interruption
  // during the greeting would be ignored.
  it("plays at roughly wall-clock speed so barge-in stays possible", async () => {
    const started = Date.now();
    await drain(createBufferTts(audio(0.6), { sampleRate: SAMPLE_RATE }));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(2000);
  });

  it("stops promptly when cancelled mid-clip", async () => {
    const tts = createBufferTts(audio(5), { sampleRate: SAMPLE_RATE });
    const started = Date.now();
    let slices = 0;
    for await (const chunk of tts.chunks()) {
      if (chunk.isFinal) break;
      if (++slices === 2) tts.cancel();
    }
    expect(Date.now() - started).toBeLessThan(1500);
    expect(slices).toBeLessThan(10);
  });

  it("can replay without pacing when a caller does not need real time", async () => {
    const started = Date.now();
    await drain(createBufferTts(audio(3), { sampleRate: SAMPLE_RATE, paced: false }));
    expect(Date.now() - started).toBeLessThan(500);
  });
});
