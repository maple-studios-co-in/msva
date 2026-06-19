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
  private inFlight = 0;
  private currentAbort: AbortController | null = null;

  constructor(
    private readonly voice: string,
    private readonly sampleRate: number,
    private readonly language: string
  ) {}

  push(text: string): void {
    if (this.cancelled) return;
    this.pending += text;
    const boundary = this.pending.search(/[.!?।]\s|[\n]/);
    if (boundary !== -1) {
      const chunk = this.pending.slice(0, boundary + 1);
      this.pending = this.pending.slice(boundary + 1);
      void this.synth(chunk, false);
    } else if (this.pending.length > 80) {
      const chunk = this.pending;
      this.pending = "";
      void this.synth(chunk, false);
    }
  }

  end(): void {
    this.ended = true;
    if (this.pending.length > 0) {
      void this.synth(this.pending, true);
      this.pending = "";
    } else {
      this.maybeClose();
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.pending = "";
    this.queue = [];
    // Abort any in-flight Sarvam request so its body reader stops producing.
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
          if (this.cancelled || (this.ended && this.inFlight === 0 && this.pending.length === 0)) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            this.resolver = resolve;
          });
        }
      })
    };
  }

  private async synth(text: string, isFinalChunk: boolean): Promise<void> {
    if (this.cancelled || !text.trim()) return;
    this.inFlight += 1;
    try {
      if (SARVAM_API_KEY) {
        await this.sarvamStreamTts(text, isFinalChunk);
      } else {
        const stub = await this.stubAudio(text);
        if (!this.cancelled) this.emit({ pcm: stub, isFinal: isFinalChunk });
      }
    } catch (error) {
      if (!this.cancelled) {
        console.error("[sarvam:tts] synth error", error);
        const stub = await this.stubAudio(text);
        if (!this.cancelled) this.emit({ pcm: stub, isFinal: isFinalChunk });
      }
    } finally {
      this.inFlight -= 1;
      if (this.ended && this.inFlight === 0 && this.pending.length === 0) this.maybeClose();
    }
  }

  /**
   * Open a streaming POST to /text-to-speech/stream and pump the response
   * body bytes into our TTS chunk queue as they arrive. Each `value` from
   * the reader is a Uint8Array of raw 16-bit PCM samples at `sampleRate`.
   */
  private async sarvamStreamTts(text: string, isFinalChunk: boolean): Promise<void> {
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
      clearTimeout(timeout);
      if (this.currentAbort === abort) this.currentAbort = null;
      const body = response.body ? await response.text() : "(no body)";
      throw new Error(`Sarvam TTS stream HTTP ${response.status}: ${body.slice(0, 240)}`);
    }

    const reader = response.body.getReader();
    let receivedBytes = 0;
    try {
      while (true) {
        if (this.cancelled) break;
        const { done, value } = await reader.read();
        if (done) break;
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
    // After the stream is fully drained, emit a sentinel chunk so the
    // consumer (pipeline.ts playback loop) can advance / mark this segment
    // complete. `isFinal` only true when the LLM has also said "end".
    if (!this.cancelled && isFinalChunk && this.pending.length === 0) {
      this.emit({ pcm: Buffer.alloc(0), isFinal: true });
    }
  }

  private async stubAudio(text: string): Promise<Buffer> {
    const ms = Math.max(60, text.length * 55);
    const sampleCount = Math.floor((ms / 1000) * this.sampleRate);
    return Buffer.alloc(sampleCount * 2);
  }

  private emit(chunk: TtsChunk) {
    if (this.resolver) {
      this.resolver({ value: chunk, done: false });
      this.resolver = null;
    } else {
      this.queue.push(chunk);
    }
  }

  private maybeClose() {
    if (this.resolver && this.cancelled) {
      this.resolver({ value: undefined, done: true });
      this.resolver = null;
      return;
    }
    if (this.resolver && this.ended && this.inFlight === 0 && this.pending.length === 0) {
      this.resolver({ value: undefined, done: true });
      this.resolver = null;
    }
  }
}

export const createSarvamTts: TtsFactory = ({ voice, sampleRate, language }) =>
  new SarvamStreamingTts(voice, sampleRate, language);
