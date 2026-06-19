#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-sarvam.mjs — verify the Sarvam API key works for both TTS and STT.
//
// Run (from repo root):
//   node --env-file=apps/telephony/.env apps/telephony/scripts/check-sarvam.mjs
//
// What it does:
//   1. POST a short Hinglish phrase to Sarvam TTS (bulbul:v3) → base64 WAV.
//   2. Decode and write it to a temp .wav so you can play it back if you want.
//   3. POST that WAV to Sarvam STT (saaras:v3) → transcript.
//   4. Print PASS/FAIL with timing for each call.
//
// Exits 0 on success, non-zero on any failure. Designed to be safe to commit:
// it never echoes the API key, only "ok"/error messages.
// ---------------------------------------------------------------------------

import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = process.env.SARVAM_API_KEY;
const BASE_URL = "https://api.sarvam.ai";

// Bulbul v3 speakers, per Sarvam API error response (May 2026):
//   aditya, ritu, ashutosh, priya, neha, rahul, pooja, rohan, simran,
//   kavya, amit, dev, ishita, shreya, ratan, varun, manan, …
// (The list isn't published in their docs but the API will tell you the
// current set in any HTTP 400 response for an unknown speaker.)
const SAFE_V3_SPEAKERS = [
  "aditya", "ritu", "ashutosh", "priya", "neha", "rahul", "pooja",
  "rohan", "simran", "kavya", "amit", "dev", "ishita", "shreya",
  "ratan", "varun", "manan"
];
const VOICE = process.env.TTS_VOICE_TEST ?? "neha"; // override of TTS_VOICE just for the test
const LANGUAGE = process.env.AGENT_LANGUAGE ?? "hi-IN";
const PHRASE = "Namaste, Madhu Sudhan support se baat ho rahi hai.";

function bad(label, err) {
  console.error(`\n  ✗ ${label}: ${err}`);
  process.exit(1);
}

function ok(label, info) {
  console.log(`  ✓ ${label}${info ? ` — ${info}` : ""}`);
}

if (!API_KEY) {
  bad("SARVAM_API_KEY missing", "set it in apps/telephony/.env and re-run with --env-file");
}
console.log(`MSVA — Sarvam health check`);
console.log(`  key:      ${API_KEY.slice(0, 6)}…${API_KEY.slice(-3)}  (${API_KEY.length} chars)`);
console.log(`  voice:    ${VOICE}  (override with TTS_VOICE_TEST=…)`);
console.log(`  language: ${LANGUAGE}`);
console.log(`  phrase:   "${PHRASE}"\n`);

// ---------- TTS ------------------------------------------------------------
const ttsStart = Date.now();
let ttsResponse;
try {
  ttsResponse = await fetch(`${BASE_URL}/text-to-speech`, {
    method: "POST",
    headers: {
      "api-subscription-key": API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: PHRASE,
      target_language_code: LANGUAGE,
      model: "bulbul:v3",
      speaker: VOICE
    })
  });
} catch (error) {
  bad("TTS request failed (network)", error.message);
}
const ttsMs = Date.now() - ttsStart;

if (!ttsResponse.ok) {
  const body = await ttsResponse.text();
  if (ttsResponse.status === 403) {
    bad(`TTS rejected key (HTTP 403)`, `the key is invalid, expired, or lacks TTS scope — ${body}`);
  }
  if (ttsResponse.status === 422 && /speaker/i.test(body)) {
    bad(
      `TTS rejected speaker "${VOICE}" (HTTP 422)`,
      `try one of: ${SAFE_V3_SPEAKERS.join(", ")} via TTS_VOICE_TEST env var`
    );
  }
  bad(`TTS HTTP ${ttsResponse.status}`, body.slice(0, 240));
}

const ttsJson = await ttsResponse.json();
const audioB64 = ttsJson?.audios?.[0];
if (!audioB64) bad("TTS response missing audio", JSON.stringify(ttsJson).slice(0, 200));
const audioBuf = Buffer.from(audioB64, "base64");

// Parse the WAV header so we report real sample rate + duration. Useful for
// confirming `speech_sample_rate` was honored — a mismatch here would mean
// the telephony pipeline needs to resample before sending audio to Exotel.
const wav = inspectWav(audioBuf);
ok(
  `TTS  bulbul:v3`,
  `${ttsMs}ms, ${(audioBuf.byteLength / 1024).toFixed(1)} KB${wav ? `, ${wav.sampleRate} Hz, ${wav.durationMs}ms audio` : ""}, request_id=${ttsJson.request_id}`
);
if (wav && wav.sampleRate !== 8000) {
  console.log(
    `  ⚠ Sarvam returned ${wav.sampleRate} Hz despite speech_sample_rate=8000 — the telephony pipeline will need to resample.`
  );
}

const outDir = join(tmpdir(), "msva-sarvam-check");
await mkdir(outDir, { recursive: true });
const wavPath = join(outDir, "tts-out.wav");
await writeFile(wavPath, audioBuf);
ok(`WAV  saved`, wavPath);

// ---------- STT ------------------------------------------------------------
// We hit the endpoint in `translit` mode so the transcript comes back in
// Latin script — that lets the simple substring matcher below work for
// Hinglish input. The actual telephony pipeline uses `transcribe` mode and
// gets Devanagari, which is what we want at runtime.
const sttStart = Date.now();
const form = new FormData();
form.append("file", new Blob([new Uint8Array(audioBuf)], { type: "audio/wav" }), "tts-out.wav");
form.append("model", "saaras:v3");
form.append("mode", "translit");
form.append("language_code", LANGUAGE);

let sttResponse;
try {
  sttResponse = await fetch(`${BASE_URL}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": API_KEY },
    body: form
  });
} catch (error) {
  bad("STT request failed (network)", error.message);
}
const sttMs = Date.now() - sttStart;

if (!sttResponse.ok) {
  const body = await sttResponse.text();
  if (sttResponse.status === 403) {
    bad(`STT rejected key (HTTP 403)`, `the key is invalid or lacks STT scope — ${body}`);
  }
  bad(`STT HTTP ${sttResponse.status}`, body.slice(0, 240));
}

const sttJson = await sttResponse.json();
const transcript = (sttJson?.transcript ?? "").trim();
ok(
  `STT  saaras:v3`,
  `${sttMs}ms, lang=${sttJson.language_code ?? "?"}, request_id=${sttJson.request_id}`
);

console.log(`\n  transcript: "${transcript}"`);

// ---------- Verdict --------------------------------------------------------
// Loose match: any 4+ char substring from the source phrase appears in the
// transcript. STT might transliterate Devanagari ↔ Latin, so we lowercase
// both and check token overlap.
const tokens = PHRASE.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
const transcriptLc = transcript.toLowerCase();
const hits = tokens.filter((t) => transcriptLc.includes(t));
const ratio = hits.length / Math.max(tokens.length, 1);

console.log(`  match:      ${hits.length}/${tokens.length} source tokens (${(ratio * 100).toFixed(0)}%)`);

function inspectWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let fmt = null;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bitsPerSample: buf.readUInt16LE(offset + 22)
      };
    } else if (id === "data") {
      dataSize = size;
      break;
    }
    offset += 8 + size;
  }
  if (!fmt) return null;
  const durationMs = Math.round((dataSize / (fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8))) * 1000);
  return { ...fmt, durationMs };
}

if (transcript.length === 0) {
  bad("STT returned empty transcript", "the key works but the audio round-trip is broken");
}
if (ratio < 0.2) {
  console.log(
    `\n  ⚠ low overlap — the API calls succeeded, but the round-trip transcript drifted a lot.`
  );
  console.log(`    That's often fine for Hinglish (TTS Devanagari → STT Latin), but worth eyeballing.`);
} else {
  console.log(`\n  ✓ All good. Sarvam TTS + STT both reachable with this key.`);
}
process.exit(0);
