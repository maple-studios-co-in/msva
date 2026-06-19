// ---------------------------------------------------------------------------
// Endpointing (caller stopped talking)
//
// This is the deliberately-dumb default: track the RMS energy of incoming
// 16-bit PCM frames, and declare end-of-utterance after `silenceMs` of
// frames below `energyFloor`. Good enough to get a pipeline running end to
// end, bad enough that you should swap it for Silero VAD as soon as you
// care about real call quality. The interface is what matters:
//
//   const detector = createEndpointer({ silenceMs: 700 });
//   detector.feed(pcm);
//   if (detector.endpointed()) { ... }
//   detector.reset();
//
// Replace the implementation with Silero (via onnxruntime-node) or with a
// provider-side endpointer (Deepgram, Sarvam streaming) without touching
// the pipeline.
// ---------------------------------------------------------------------------

export type EndpointerOptions = {
  sampleRate?: number; // default 8000
  silenceMs?: number; // default 700
  energyFloor?: number; // RMS threshold, default 350
  minVoicedMs?: number; // ignore endpoints before this much speech, default 250
};

export type Endpointer = {
  feed(pcm: Buffer): void;
  endpointed(): boolean;
  reset(): void;
  voicedMs(): number;
};

export function createEndpointer(options: EndpointerOptions = {}): Endpointer {
  const sampleRate = options.sampleRate ?? 8000;
  const silenceMs = options.silenceMs ?? 700;
  const energyFloor = options.energyFloor ?? 350;
  const minVoicedMs = options.minVoicedMs ?? 250;

  let voicedMs = 0;
  let trailingSilenceMs = 0;

  return {
    feed(pcm: Buffer) {
      // 16-bit signed little-endian samples.
      const sampleCount = pcm.length / 2;
      if (sampleCount === 0) return;

      let sumSquares = 0;
      for (let i = 0; i < pcm.length; i += 2) {
        const sample = pcm.readInt16LE(i);
        sumSquares += sample * sample;
      }
      const rms = Math.sqrt(sumSquares / sampleCount);
      const chunkMs = (sampleCount / sampleRate) * 1000;

      if (rms > energyFloor) {
        voicedMs += chunkMs;
        trailingSilenceMs = 0;
      } else {
        trailingSilenceMs += chunkMs;
      }
    },
    endpointed() {
      return voicedMs >= minVoicedMs && trailingSilenceMs >= silenceMs;
    },
    reset() {
      voicedMs = 0;
      trailingSilenceMs = 0;
    },
    voicedMs() {
      return voicedMs;
    }
  };
}
