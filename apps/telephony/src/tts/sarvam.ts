import type { StreamingTts, TtsChunk, TtsFactory } from "./index.js";

// ---------------------------------------------------------------------------
// Sarvam TTS (HTTP streaming)
//
// Endpoint: POST https://api.sarvam.ai/text-to-speech/stream
//   • Response body is raw binary audio (NOT JSON, NOT base64).
//   • output_audio_codec="linear16" → raw 16-bit signed-LE PCM (no header).
//   • speech_sample_rate=8000      → 8 kHz, matches Exotel directly.
//   • Bytes arrive as the response streams; we forward them to TTS chunk
//     consumers as soon as we read each chunk from `response.body`.
//
// Strategy:
//   • Buffer incoming text deltas (from the LLM token stream).
//   • Flush a sentence-shaped chunk to Sarvam on punctuation OR after ~80
//     chars so the first audio chunk ships before the LLM is done.
//   • For each text chunk: open a streaming POST, pump bytes from the body
//     reader → TtsChunk, repeat for the next text chunk.
//
// When SARVAM_API_KEY is missing we fall through to silent PCM of roughly
// the right duration so the pipeline can be exercised end-to-end without
// a network round-trip.
// ---------------------------------------------------------------------------

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const SARVAM_BASE_URL = process.env.SARVAM_BASE_URL ?? "https://api.sarvam.ai";
const SARVAM_TTS_MODEL = process.env.SARVAM_TTS_MODEL ?? "bulbul:v3";
const SARVAM_TTS_TIMEOUT_MS = Number(process.env.SARVAM_TTS_TIMEOUT_MS ?? 8000);

class SarvamStreamingTts implements StreamingTts {
  private pending = "";
  private ended = false;
  private cancelled = false;
  private queue: TtsChunk[] = [];
  private resolver: ((value: IteratorResult<TtsChunk>) => void) | null = null;
  private textQueue: string[] = [];
  private synthesizing = false;
  private finished = false;
  private currentAbort: AbortController | null = null;

  constructor(
    private readonly voice: string,
    private readonly sampleRate: number,
    private readonly language: string
  ) {}

  push(text: string): void {
    if (this.cancelled || this.ended) return;
    this.pending += text;
    let boundary: number;
    while ((boundary = this.pending.search(/[.!?।]\s|[\n]/)) !== -1) {
      this.enqueue(this.pending.slice(0, boundary + 1));
      this.pending = this.pending.slice(boundary + 1);
    }
    if (this.pending.length > 80) {
      this.enqueue(this.pending);
      this.pending = "";
    }
    void this.drain();
  }

  end(): void {
    if (this.cancelled || this.ended) return;
    this.ended = true;
    this.enqueue(this.pending);
    this.pending = "";
    void this.drain();
  }

  cancel(): void {
    this.cancelled = true;
    this.pending = "";
    this.textQueue = [];
    this.queue = [];
    this.currentAbort?.abort();
    this.currentAbort = null;
    this.maybeClose();
  }

  chunks(): AsyncIterable<TtsChunk> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<TtsChunk>> => {
          if (this.queue.length > 0) {
            return Promise.resolve({ value: this.queue.shift()!, done: false });
          }
          if (this.cancelled || this.finished) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => { this.resolver = resolve; });
        }
      })
    };
  }

  private enqueue(text: string): void {
    if (text.trim()) this.textQueue.push(text.trim());
  }

  private async drain(): Promise<void> {
    if (this.synthesizing || this.cancelled || this.finished) return;
    this.synthesizing = true;
    try {
      while (!this.cancelled && this.textQueue.length > 0) {
        const text = this.textQueue.shift()!;
        try {
          if (SARVAM_API_KEY) await this.sarvamStreamTts(text);
          else this.emit({ pcm: await this.stubAudio(text), isFinal: false });
        } catch (error) {
          if (!this.cancelled) {
            console.error("[sarvam:tts] synth error", error);
            this.emit({ pcm: await this.stubAudio(text), isFinal: false });
          }
        }
      }
    } finally {
      this.synthesizing = false;
      // A single final marker belongs to the whole utterance, never an
      // individual request. All preceding PCM is already queued in order.
      if (!this.cancelled && this.ended && this.textQueue.length === 0) {
        this.finished = true;
        this.emit({ pcm: Buffer.alloc(0), isFinal: true });
      }
      this.maybeClose();
    }
  }

  /**
   * Open a streaming POST to /text-to-speech/stream and pump the response
   * body bytes into our TTS chunk queue as they arrive. Each `value` from
   * the reader is a Uint8Array of raw 16-bit PCM samples at `sampleRate`.
   */
  private async sarvamStreamTts(text: string): Promise<void> {
    const abort = new AbortController();
    this.currentAbort = abort;
    const timeout = setTimeout(() => abort.abort(), SARVAM_TTS_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${SARVAM_BASE_URL}/text-to-speech/stream`, {
        method: "POST",
        signal: abort.signal,
        headers: {
          "api-subscription-key": SARVAM_API_KEY!,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          target_language_code: this.language,
          speaker: this.voice,
          model: SARVAM_TTS_MODEL,
          output_audio_codec: "linear16",
          speech_sample_rate: this.sampleRate
        })
      });
    } catch (error) {
      clearTimeout(timeout);
      if (this.currentAbort === abort) this.currentAbort = null;
      throw error;
    }

    if (!response.ok || !response.body) {
      // Error bodies can stall too. Status is enough to diagnose this failure;
      // abort the response without waiting for its body and release the queue.
      abort.abort();
      clearTimeout(timeout);
      if (this.currentAbort === abort) this.currentAbort = null;
      throw new Error(`Sarvam TTS stream HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    let receivedBytes = 0;
    try {
      while (true) {
        if (this.cancelled) break;
        const { done, value } = await reader.read();
        if (done || this.cancelled) break;
        if (value && value.byteLength > 0) {
          receivedBytes += value.byteLength;
          // Forward bytes immediately — don't wait for the whole clip.
          this.emit({ pcm: Buffer.from(value), isFinal: false });
        }
      }
    } finally {
      clearTimeout(timeout);
      try { reader.releaseLock(); } catch { /* ignore */ }
      if (this.currentAbort === abort) this.currentAbort = null;
    }

    if (!this.cancelled && receivedBytes === 0) {
      throw new Error("Sarvam TTS stream returned zero bytes");
    }
  }

  private async stubAudio(text: string): Promise<Buffer> {
    const ms = Math.max(60, text.length * 55);
    const sampleCount = Math.floor((ms / 1000) * this.sampleRate);
    return Buffer.alloc(sampleCount * 2);
  }

  private emit(chunk: TtsChunk) {
    if (this.cancelled) return;
    if (this.resolver) {
      this.resolver({ value: chunk, done: false });
      this.resolver = null;
    } else {
      this.queue.push(chunk);
    }
  }

  private maybeClose() {
    if (this.resolver && (this.cancelled || (this.finished && this.queue.length === 0))) {
      this.resolver({ value: undefined, done: true });
      this.resolver = null;
    }
  }

}

export const createSarvamTts: TtsFactory = ({ voice, sampleRate, language }) =>
  new SarvamStreamingTts(voice, sampleRate, language);
