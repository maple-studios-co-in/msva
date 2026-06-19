// ---------------------------------------------------------------------------
// ASR adapter interface
//
// A `StreamingAsr` consumes successive PCM buffers (8kHz, 16-bit, mono) and
// yields partial + final transcripts. `final` events are committed to the
// agent loop; `partial` events are not used today but are exposed so a
// future barge-in optimization can start an LLM speculative completion.
//
// Implementations live alongside this file: `sarvam.ts`, `bhashini.ts`,
// `deepgram.ts`. The pipeline picks one by env var `ASR_PROVIDER`.
// ---------------------------------------------------------------------------

export type AsrEvent =
  | { type: "partial"; text: string; confidence: number }
  | { type: "final"; text: string; confidence: number; durationMs: number };

export type StreamingAsr = {
  /** Push a chunk of PCM audio into the recognizer. */
  feed(pcm: Buffer): Promise<void>;
  /** Signal end-of-utterance — the recognizer should flush a final result. */
  endpoint(): Promise<void>;
  /** Yield ASR events as they arrive. */
  events(): AsyncIterable<AsrEvent>;
  /** Tear down the underlying connection. */
  close(): Promise<void>;
};

export type AsrFactory = (options: { language: string; sampleRate: number }) => StreamingAsr;
