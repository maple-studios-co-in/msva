// ---------------------------------------------------------------------------
// Minimal WAV reader/writer for 16-bit PCM.
//
// The pipeline speaks raw PCM everywhere; WAV only exists at the edges, where
// a human needs to play a file. Rather than pull in a dependency for a 44-byte
// header, this handles the one format we care about and refuses anything else
// loudly, so a stereo or 24-bit file fails at the boundary instead of turning
// into noise three layers down.
// ---------------------------------------------------------------------------

export type WavAudio = { pcm: Buffer; sampleRate: number; channels: number };

const RIFF = 0x52494646; // "RIFF"
const WAVE = 0x57415645; // "WAVE"

/** Parse a 16-bit PCM WAV. Throws with a readable reason on anything else. */
export function decodeWav(file: Buffer): WavAudio {
  if (file.byteLength < 44) throw new Error("not a WAV file: shorter than a header");
  if (file.readUInt32BE(0) !== RIFF) throw new Error("not a WAV file: missing RIFF marker");
  if (file.readUInt32BE(8) !== WAVE) throw new Error("not a WAV file: missing WAVE marker");

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let format = 0;
  let seenFmt = false;

  // Walk the chunk list rather than assuming fmt then data: recorders often
  // insert LIST or fact chunks between them.
  while (offset + 8 <= file.byteLength) {
    const id = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      format = file.readUInt16LE(body);
      channels = file.readUInt16LE(body + 2);
      sampleRate = file.readUInt32LE(body + 4);
      bitsPerSample = file.readUInt16LE(body + 14);
      seenFmt = true;
    } else if (id === "data") {
      if (!seenFmt) throw new Error("malformed WAV: data chunk before fmt chunk");
      if (format !== 1) throw new Error(`unsupported WAV: format ${format}, expected 1 (PCM)`);
      if (bitsPerSample !== 16) throw new Error(`unsupported WAV: ${bitsPerSample}-bit, expected 16`);
      const end = Math.min(body + size, file.byteLength);
      return { pcm: file.subarray(body, end), sampleRate, channels };
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }
  throw new Error("malformed WAV: no data chunk");
}

/** Wrap raw 16-bit PCM in a WAV header so a person can play it. */
export function encodeWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const bytesPerSample = 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  header.writeUInt16LE(channels * bytesPerSample, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Nearest-neighbour resample of 16-bit mono PCM.
 *
 * Deliberately crude. It exists so a 16 kHz recording can be pushed down the
 * 8 kHz telephone path in a test harness; it is not in the live call path and
 * makes no attempt at anti-aliasing.
 */
export function resamplePcm16(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to) return pcm;
  const inSamples = Math.floor(pcm.byteLength / 2);
  const outSamples = Math.max(1, Math.floor((inSamples * to) / from));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i += 1) {
    const src = Math.min(inSamples - 1, Math.floor((i * from) / to));
    out.writeInt16LE(pcm.readInt16LE(src * 2), i * 2);
  }
  return out;
}

/** Average interleaved stereo down to mono. */
export function toMono(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.byteLength / (2 * channels));
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += pcm.readInt16LE((i * channels + c) * 2);
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}
