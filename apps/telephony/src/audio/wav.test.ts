import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav, resamplePcm16, toMono } from "./wav.js";

const pcm = (samples: number[]): Buffer => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};

describe("encodeWav / decodeWav", () => {
  it("round-trips audio unchanged", () => {
    const original = pcm([0, 1000, -1000, 32767, -32768]);
    const decoded = decodeWav(encodeWav(original, 8000));
    expect(decoded.pcm).toEqual(original);
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.channels).toBe(1);
  });

  it("writes a header a player can read", () => {
    const wav = encodeWav(pcm([1, 2]), 16000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(32000); // byte rate = rate * channels * 2
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
  });

  it("finds the data chunk past an intervening LIST chunk", () => {
    const base = encodeWav(pcm([7, 8, 9]), 8000);
    const fmt = base.subarray(12, 36);
    const data = base.subarray(36);
    const list = Buffer.concat([
      Buffer.from("LIST", "ascii"),
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(4); return b; })(),
      Buffer.from("INFO", "ascii")
    ]);
    const body = Buffer.concat([fmt, list, data]);
    const header = Buffer.alloc(12);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(4 + body.byteLength, 4);
    header.write("WAVE", 8, "ascii");
    expect(decodeWav(Buffer.concat([header, body])).pcm).toEqual(pcm([7, 8, 9]));
  });

  it("rejects a non-WAV buffer with a readable reason", () => {
    expect(() => decodeWav(Buffer.alloc(64))).toThrow(/RIFF/);
    expect(() => decodeWav(Buffer.from("hi"))).toThrow(/shorter than a header/);
  });

  it("rejects 24-bit audio rather than misreading it", () => {
    const wav = encodeWav(pcm([1, 2]), 8000);
    wav.writeUInt16LE(24, 34);
    expect(() => decodeWav(wav)).toThrow(/24-bit/);
  });
});

describe("resamplePcm16", () => {
  it("returns the input untouched when rates match", () => {
    const input = pcm([1, 2, 3]);
    expect(resamplePcm16(input, 8000, 8000)).toBe(input);
  });

  it("halves the sample count going 16 kHz to 8 kHz", () => {
    const input = pcm([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(resamplePcm16(input, 16000, 8000).byteLength / 2).toBe(4);
  });

  it("keeps the leading sample so audio does not shift in time", () => {
    const out = resamplePcm16(pcm([100, 200, 300, 400]), 16000, 8000);
    expect(out.readInt16LE(0)).toBe(100);
  });
});

describe("toMono", () => {
  it("averages a stereo pair", () => {
    const stereo = pcm([100, 200, 300, 500]);
    const mono = toMono(stereo, 2);
    expect(mono.readInt16LE(0)).toBe(150);
    expect(mono.readInt16LE(2)).toBe(400);
  });

  it("leaves mono alone", () => {
    const mono = pcm([1, 2]);
    expect(toMono(mono, 1)).toBe(mono);
  });
});
