// ---------------------------------------------------------------------------
// TTS adapter interface
//
// `StreamingTts` accepts a sequence of text deltas (from the LLM token
// stream) and yields PCM buffers ready to be base64-encoded and pushed back
// over the telephony WebSocket. `cancel()` exists for barge-in: if the
// caller starts speaking while the agent is still playing, the pipeline
// kills the in-flight TTS and clears Exotel's playback queue.
// ---------------------------------------------------------------------------

export type TtsChunk = { pcm: Buffer; isFinal: boolean };

export type StreamingTts = {
  /** Append text to the synthesis queue. Returns immediately. */
  push(text: string): void;
  /** No more text will arrive — flush remaining audio. */
  end(): void;
  /** Cancel synthesis and discard pending audio (barge-in). */
  cancel(): void;
  /** Yield audio chunks as they're produced. */
  chunks(): AsyncIterable<TtsChunk>;
};

export type TtsFactory = (options: {
  voice: string;
  language: string;
  sampleRate: number;
}) => StreamingTts;
