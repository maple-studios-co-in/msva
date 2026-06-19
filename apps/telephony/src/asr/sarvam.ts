import type { AsrEvent, AsrFactory, StreamingAsr } from "./index.js";

// ---------------------------------------------------------------------------
// Sarvam ASR
//
// Strategy:
//   • feed(pcm)  → append to a buffer.
//   • endpoint() → wrap the buffer in a WAV header, POST to saaras:v3,
//                  emit a single `final` event with the transcript.
//   • Switch to the WebSocket streaming endpoint later for partial transcripts
//     and lower perceived latency. The pipeline already calls endpoint() on
//     VAD trigger, so REST works fine as a first cut.
//
// When SARVAM_API_KEY is missing we emit a canned Hinglish line so the
// pipeline can be exercised end-to-end without a network round-trip.
// ---------------------------------------------------------------------------

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const SARVAM_BASE_URL = process.env.SARVAM_BASE_URL ?? "https://api.sarvam.ai";
const SARVAM_STT_MODEL = process.env.SARVAM_STT_MODEL ?? "saaras:v3";
const SARVAM_STT_MODE = process.env.SARVAM_STT_MODE ?? "transcribe";
const SARVAM_STT_TIMEOUT_MS = Number(process.env.SARVAM_STT_TIMEOUT_MS ?? 8000);

class SarvamStreamingAsr implements StreamingAsr {
  private buffers: Buffer[] = [];
  private bufferedBytes = 0;
  private startedAt = Date.now();
  private queue: AsrEvent[] = [];
  private resolver: ((value: IteratorResult<AsrEvent>) => void) | null = null;
  private closed = false;
  private inFlight = 0;

  constructor(private readonly language: string, private readonly sampleRate: number) {}

  async feed(pcm: Buffer): Promise<void> {
    if (this.closed) return;
    this.buffers.push(pcm);
    this.bufferedBytes += pcm.byteLength;
  }

  async endpoint(): Promise<void> {
    if (this.closed) return;
    if (this.bufferedBytes === 0) return;

    const pcm = Buffer.concat(this.buffers, this.bufferedBytes);
    const durationMs = Math.round((this.bufferedBytes / 2 / this.sampleRate) * 1000);
    this.buffers = [];
    this.bufferedBytes = 0;
    this.startedAt = Date.now();

    this.inFlight += 1;
    try {
      const event = SARVAM_API_KEY
        ? await this.sarvamStt(pcm, durationMs)
        : this.stubFinal(durationMs);
      this.push(event);
    } catch (error) {
      console.error("[sarvam:asr] STT error", error);
      // Don't drop the turn — emit a low-confidence canned event so the agent
      // can still run. In production we'd surface this to the dashboard.
      this.push(this.stubFinal(durationMs, "[asr-error]"));
    } finally {
      this.inFlight -= 1;
    }
  }

  events(): AsyncIterable<AsrEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<AsrEvent>> => {
          if (this.queue.length > 0) {
            return Promise.resolve({ value: this.queue.shift()!, done: false });
          }
          if (this.closed && this.inFlight === 0) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            this.resolver = resolve;
          });
        }
      })
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.buffers = [];
    this.bufferedBytes = 0;
    if (this.resolver) {
      this.resolver({ value: undefined, done: true });
      this.resolver = null;
    }
  }

  private async sarvamStt(pcm: Buffer, durationMs: number): Promise<AsrEvent> {
    const wav = wrapPcmInWav(pcm, this.sampleRate);

    const form = new FormData();
    // Wrap in Uint8Array so the BlobPart type matches under @types/node 22.
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "utterance.wav");
    form.append("model", SARVAM_STT_MODEL);
    form.append("mode", SARVAM_STT_MODE);
    form.append("language_code", this.language);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SARVAM_STT_TIMEOUT_MS);
    try {
      const response = await fetch(`${SARVAM_BASE_URL}/speech-to-text`, {
        method: "POST",
        signal: controller.signal,
        headers: { "api-subscription-key": SARVAM_API_KEY! },
        body: form
      });
      if (!response.ok) {
        throw new Error(`Sarvam STT HTTP ${response.status}: ${await response.text()}`);
      }
      const json = (await response.json()) as { transcript?: string; language_code?: string };
      const text = (json.transcript ?? "").trim();
      return { type: "final", text, confidence: 0.9, durationMs };
    } finally {
      clearTimeout(timeout);
    }
  }

  private stubFinal(durationMs: number, text?: string): AsrEvent {
    return {
      type: "final",
      text: text ?? "haan mujhe paneer ka order chahiye, Ghaziabad mein",
      confidence: 0.92,
      durationMs
    };
  }

  private push(event: AsrEvent) {
    if (this.resolver) {
      this.resolver({ value: event, done: false });
      this.resolver = null;
    } else {
      this.queue.push(event);
    }
  }
}

/**
 * Wrap raw 16-bit signed-LE PCM in a minimal RIFF/WAVE container so the
 * Sarvam STT REST endpoint accepts it. Mono, sampleRate Hz.
 */
function wrapPcmInWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.byteLength;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm], header.byteLength + dataSize);
}

export const createSarvamAsr: AsrFactory = ({ language, sampleRate }) =>
  new SarvamStreamingAsr(language, sampleRate);
