#!/usr/bin/env node
// ---------------------------------------------------------------------------
// transcribe-samples.mjs — batch-transcribe a folder of real call WAVs.
//
// Run (from repo root):
//   node --env-file=apps/telephony/.env apps/telephony/scripts/transcribe-samples.mjs
//
// What it does for every .wav under apps/telephony/test-fixtures/calls/:
//   1. POSTs to Sarvam STT saaras:v3 mode=transcribe — original-language text
//      (Hindi → Devanagari, Hinglish stays code-mixed)
//   2. POSTs again with mode=translate — English version for quick intent triage
//   3. Writes apps/telephony/test-fixtures/transcripts/<filename>.md with both
//   4. Aggregates everything into transcripts/_summary.json
//
// This script never commits anything. The transcripts folder is gitignored —
// real customer audio + transcripts stay on your machine only.
//
// Output you can use:
//   • A categorized view of caller intents across the sample set
//   • Real Hinglish phrases you can paste into demo-call seeds
//   • A baseline for the post-call extraction schema (what fields callers
//     actually mention without prompting)
// ---------------------------------------------------------------------------

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "test-fixtures", "calls");
const OUTPUT_DIR = join(__dirname, "..", "test-fixtures", "transcripts");

const API_KEY = process.env.SARVAM_API_KEY;
const BASE_URL = process.env.SARVAM_BASE_URL ?? "https://api.sarvam.ai";
const LANGUAGE = process.env.AGENT_LANGUAGE ?? "hi-IN";
const MODEL = "saaras:v3";
const TIMEOUT_MS = Number(process.env.SARVAM_STT_TIMEOUT_MS ?? 30000);

if (!API_KEY) {
  console.error("✗ SARVAM_API_KEY missing. Run with: node --env-file=apps/telephony/.env …");
  process.exit(1);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

if (!(await exists(FIXTURES_DIR))) {
  console.error(`✗ Fixtures folder not found: ${FIXTURES_DIR}`);
  console.error(`  Drop your .wav files there and re-run.`);
  process.exit(1);
}
await mkdir(OUTPUT_DIR, { recursive: true });

async function sttCall(buf, mode, filename) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), filename);
  form.append("model", MODEL);
  form.append("mode", mode);
  form.append("language_code", LANGUAGE);

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(`${BASE_URL}/speech-to-text`, {
      method: "POST",
      signal: abort.signal,
      headers: { "api-subscription-key": API_KEY },
      body: form
    });
    const ms = Date.now() - started;
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, mode, ms, error: `HTTP ${response.status}: ${body.slice(0, 240)}` };
    }
    const json = await response.json();
    return {
      ok: true,
      mode,
      ms,
      transcript: (json.transcript ?? "").trim(),
      detectedLanguage: json.language_code ?? null,
      requestId: json.request_id ?? null
    };
  } catch (error) {
    const aborted = error.name === "AbortError";
    return {
      ok: false,
      mode,
      ms: Date.now() - started,
      error: aborted ? `timeout after ${TIMEOUT_MS}ms` : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

const files = (await readdir(FIXTURES_DIR))
  .filter((f) => f.toLowerCase().endsWith(".wav"))
  .sort();

if (files.length === 0) {
  console.error(`✗ No .wav files found in ${FIXTURES_DIR}`);
  process.exit(1);
}

console.log(`MSVA — transcribing ${files.length} call sample(s) via Sarvam ${MODEL}\n`);

const summary = [];
for (const filename of files) {
  const filepath = join(FIXTURES_DIR, filename);
  const buf = await readFile(filepath);
  const sizeKB = (buf.byteLength / 1024).toFixed(1);
  process.stdout.write(`  • ${filename}  (${sizeKB} KB)  → `);

  const transcribe = await sttCall(buf, "transcribe", filename);
  const translate = await sttCall(buf, "translate", filename);

  if (!transcribe.ok || !translate.ok) {
    console.log(`✗`);
    if (!transcribe.ok) console.log(`    transcribe: ${transcribe.error}`);
    if (!translate.ok) console.log(`    translate:  ${translate.error}`);
    summary.push({ filename, ok: false, error: transcribe.error ?? translate.error });
    continue;
  }

  console.log(`✓ transcribe ${transcribe.ms}ms, translate ${translate.ms}ms`);

  const md = `# ${filename}

- size: ${sizeKB} KB
- detected language: \`${transcribe.detectedLanguage}\`
- STT model: \`${MODEL}\`
- transcribe request: \`${transcribe.requestId}\` (${transcribe.ms}ms)
- translate request: \`${translate.requestId}\` (${translate.ms}ms)

## Original transcript (mode=transcribe)

> ${transcribe.transcript || "_(empty)_"}

## English translation (mode=translate)

> ${translate.transcript || "_(empty)_"}
`;
  await writeFile(join(OUTPUT_DIR, `${basename(filename, ".wav")}.md`), md);

  summary.push({
    filename,
    sizeKB: Number(sizeKB),
    detectedLanguage: transcribe.detectedLanguage,
    transcribe: { text: transcribe.transcript, ms: transcribe.ms },
    translate: { text: translate.transcript, ms: translate.ms }
  });
}

await writeFile(join(OUTPUT_DIR, "_summary.json"), JSON.stringify(summary, null, 2));

console.log(`\nDone. Output:`);
console.log(`  • ${OUTPUT_DIR}/<filename>.md   — per-call Devanagari + English`);
console.log(`  • ${OUTPUT_DIR}/_summary.json   — machine-readable aggregate`);
console.log(`\nNext: read the .md files, look for:`);
console.log(`  - common opening lines (caller's first 5 seconds)`);
console.log(`  - questions / intents we don't currently handle`);
console.log(`  - fields callers mention (order #, batch #, location, product)`);
console.log(`  - escalation triggers (anger, "agent se baat karwao", etc.)`);
