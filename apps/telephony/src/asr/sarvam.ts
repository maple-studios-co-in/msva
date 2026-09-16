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

const MAX_SEGMENT_MS = 25_000; // Sarvam REST requires audio shorter than 30 seconds.
const MAX_QUEUED_SEGMENTS = 2;
const PRE_ROLL_MS = 200;
const MIN_VOICED_MS = 250;
const MAX_TRANSCRIPT_CHARS = 8000;

type Utterance = {
  text: string[];
  durationMs: number;
  pending: number;
  closed: boolean;
  failed: boolean;
  done: Promise<void>;
  resolve: () => void;
};
type Segment = { pcm: Buffer; durationMs: number; utterance: Utterance };

class SarvamStreamingAsr implements StreamingAsr {
  private buffers: Buffer[] = [];
  private bufferedBytes = 0;
  private voicedMs = 0;
  private silentMs = 0;
  private preRoll = Buffer.alloc(0);
  private utterance: Utterance | null = null;
  private segments: Segment[] = [];
  private recognizing = false;
  private currentAbort: AbortController | null = null;
  private queue: AsrEvent[] = [];
  private resolver: ((value: IteratorResult<AsrEvent>) => void) | null = null;
  private closed = false;

  constructor(
    private readonly language: string,
    private readonly sampleRate: number,
    private readonly energyFloor = 350
  ) {}

  async feed(pcm: Buffer): Promise<void> {
    if (this.closed) return;
    // Inspect small frames even when a transport batches several seconds.
    const frameBytes = Math.max(2, Math.floor(this.sampleRate * 0.02) * 2);
    const maxBytes = Math.floor(this.sampleRate * 2 * MAX_SEGMENT_MS / 1000);
    for (let offset = 0; offset + 1 < pcm.length; offset += frameBytes) {
      const frame = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length - pcm.length % 2));
      let power = 0;
      for (let i = 0; i < frame.length; i += 2) power += frame.readInt16LE(i) ** 2;
      const voiced = Math.sqrt(power / (frame.length / 2)) > this.energyFloor;
      const ms = frame.length / (this.sampleRate * 2) * 1000;
      if (!this.utterance && !voiced) {
        const limit = Math.round(this.sampleRate * 2 * PRE_ROLL_MS / 1000);
        this.preRoll = Buffer.from(Buffer.concat([this.preRoll, frame]).subarray(-limit));
        continue;
      }
      if (!this.utterance) {
        let resolve!: () => void;
        const done = new Promise<void>(r => { resolve = r; });
        this.utterance = { text: [], durationMs: 0, pending: 0, closed: false, failed: false, done, resolve };
        this.buffers = this.preRoll.length ? [this.preRoll] : [];
        this.bufferedBytes = this.preRoll.length;
        this.preRoll = Buffer.alloc(0);
      }
      this.buffers.push(Buffer.from(frame));
      this.bufferedBytes += frame.length;
      if (voiced) { this.voicedMs += ms; this.silentMs = 0; }
      else this.silentMs += ms;
      if (this.bufferedBytes >= maxBytes) this.flushSegment();
      // Also bound a brief noise burst followed by silence if the external
      // VAD never regards it as a valid utterance.
      if (this.silentMs >= 1000) void this.endpoint();
    }
  }

  async endpoint(): Promise<void> {
    if (this.closed || !this.utterance) { this.preRoll = Buffer.alloc(0); return; }
    const utterance = this.utterance;
    if (this.voicedMs >= MIN_VOICED_MS || utterance.pending > 0) this.flushSegment();
    else { this.buffers = []; this.bufferedBytes = 0; }
    utterance.closed = true;
    this.utterance = null;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.preRoll = Buffer.alloc(0);
    this.finishUtterance(utterance);
    await utterance.done;
  }

  private flushSegment(): void {
    if (!this.utterance || !this.bufferedBytes) return;
    const utterance = this.utterance;
    const pcm = Buffer.concat(this.buffers, this.bufferedBytes);
    const durationMs = Math.round(this.bufferedBytes / (this.sampleRate * 2) * 1000);
    this.buffers = [];
    this.bufferedBytes = 0;
    if (utterance.failed) return;
    if (this.segments.length >= MAX_QUEUED_SEGMENTS) {
      this.failUtterance(utterance, "backlog_full");
      return;
    }
    utterance.pending += 1;
    utterance.durationMs += durationMs;
    this.segments.push({ pcm, durationMs, utterance });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.recognizing || this.closed) return;
    this.recognizing = true;
    try {
      while (!this.closed && this.segments.length) {
        const segment = this.segments.shift()!;
        const { utterance } = segment;
        try {
          const event = SARVAM_API_KEY
            ? await this.sarvamStt(segment.pcm, segment.durationMs)
            : this.stubFinal(segment.durationMs);
          if (!this.closed && !utterance.failed && event.type === "final") {
            utterance.text.push(event.text);
            if (utterance.text.join(" ").length > MAX_TRANSCRIPT_CHARS) this.failUtterance(utterance, "backlog_full");
          }
        } catch (error) {
          if (!this.closed) {
            console.error("[sarvam:asr] STT error", error);
            this.failUtterance(utterance, "recognition_failed");
          }
        } finally {
          utterance.pending -= 1;
          this.finishUtterance(utterance);
        }
      }
    } finally { this.recognizing = false; }
  }

  private failUtterance(utterance: Utterance, code: "recognition_failed" | "backlog_full"): void {
    if (utterance.failed) return;
    utterance.failed = true;
    utterance.text = [];
    this.push({ type: "error", code, retryable: true, message: "Speech recognition was unavailable. Please repeat." });
  }

  private finishUtterance(utterance: Utterance): void {
    if (!utterance.closed || utterance.pending > 0) return;
    const text = utterance.text.join(" ").trim();
    if (!this.closed && !utterance.failed && text) {
      this.push({ type: "final", text, confidence: 0.9, durationMs: utterance.durationMs });
      utterance.text = [];
    }
    utterance.resolve();
  }

  events(): AsyncIterable<AsrEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<AsrEvent>> => {
          if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift()!, done: false });
          if (this.closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { this.resolver = resolve; });
        }
      })
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.currentAbort?.abort();
    this.currentAbort = null;
    this.buffers = [];
    this.bufferedBytes = 0;
    this.preRoll = Buffer.alloc(0);
    this.queue = [];
    this.utterance?.resolve();
    this.utterance = null;
    for (const segment of this.segments) {
      segment.utterance.pending -= 1;
      segment.utterance.resolve();
    }
    this.segments = [];
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
    this.currentAbort = controller;
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
      if (this.currentAbort === controller) this.currentAbort = null;
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
    if (this.closed) return;
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

export const createSarvamAsr: AsrFactory = ({ language, sampleRate, energyFloor }) =>
  new SarvamStreamingAsr(language, sampleRate, energyFloor);
