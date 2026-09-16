// ---------------------------------------------------------------------------
// Render the fixed lines in data/prompts.json to raw PCM, once.
//
//   pnpm --filter @msva/telephony render:prompts
//
// Reads SARVAM_API_KEY, TTS_VOICE, AGENT_LANGUAGE from the telephony .env so
// the clips match exactly what the live pipeline would have produced. Output
// goes to data/prompt-audio/ as <key>.<language>.<voice>.<rate>.pcm plus an
// index.json the runtime reads.
//
// Re-run this whenever a line in data/prompts.json changes, or when the voice
// changes. A stale clip is never played: the lookup key includes the text and
// the voice, so anything that no longer matches simply falls back to live
// synthesis.
//
// The output is plain PCM at the pipeline's sample rate, so a future renderer
// (a cloned Madhusudan voice, say) can drop files into the same folder and the
// runtime needs no change at all.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../src/env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const PROMPTS_PATH = join(ROOT, "data/prompts.json");
const OUT_DIR = process.env.PROMPT_AUDIO_DIR
  ? resolve(process.cwd(), process.env.PROMPT_AUDIO_DIR)
  : join(ROOT, "data/prompt-audio");

const SAMPLE_RATE = Number(process.env.PROMPT_SAMPLE_RATE ?? 8000);
const LANGUAGE = process.env.AGENT_LANGUAGE ?? "hi-IN";
const VOICE = process.env.TTS_VOICE ?? "neha";
const API_KEY = process.env.SARVAM_API_KEY;
const BASE_URL = process.env.SARVAM_BASE_URL ?? "https://api.sarvam.ai";
const MODEL = process.env.SARVAM_TTS_MODEL ?? "bulbul:v3";

type Prompt = { key: string; text: string; usedFor?: string };

async function synthesise(text: string): Promise<Buffer> {
  const response = await fetch(`${BASE_URL}/text-to-speech/stream`, {
    method: "POST",
    headers: { "api-subscription-key": API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      target_language_code: LANGUAGE,
      speaker: VOICE,
      model: MODEL,
      output_audio_codec: "linear16",
      speech_sample_rate: SAMPLE_RATE
    })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const parts: Buffer[] = [];
  const reader = response.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.byteLength) parts.push(Buffer.from(value));
  }
  const pcm = Buffer.concat(parts);
  if (pcm.byteLength === 0) throw new Error("returned zero bytes");
  return pcm;
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("SARVAM_API_KEY is not set. Run this from apps/telephony with the .env in place.");
    process.exit(1);
  }

  const { prompts } = JSON.parse(readFileSync(PROMPTS_PATH, "utf8")) as { prompts: Prompt[] };
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Rendering ${prompts.length} line(s) as ${VOICE}/${LANGUAGE} @ ${SAMPLE_RATE} Hz\n`);

  const entries = [];
  let failures = 0;

  for (const prompt of prompts) {
    const file = `${prompt.key}.${LANGUAGE}.${VOICE}.${SAMPLE_RATE}.pcm`;
    try {
      const started = Date.now();
      const pcm = await synthesise(prompt.text);
      writeFileSync(join(OUT_DIR, file), pcm);
      const seconds = pcm.byteLength / 2 / SAMPLE_RATE;
      entries.push({
        key: prompt.key,
        text: prompt.text,
        file,
        voice: VOICE,
        language: LANGUAGE,
        sampleRate: SAMPLE_RATE,
        bytes: pcm.byteLength,
        renderedAt: new Date().toISOString()
      });
      console.log(
        `  ok   ${prompt.key.padEnd(16)} ${seconds.toFixed(1)}s audio, ` +
          `${(pcm.byteLength / 1024).toFixed(0)} KB, took ${Date.now() - started} ms`
      );
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${prompt.key.padEnd(16)} ${(error as Error).message}`);
    }
  }

  writeFileSync(
    join(OUT_DIR, "index.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2) + "\n"
  );

  const totalKb = entries.reduce((sum, e) => sum + e.bytes, 0) / 1024;
  console.log(`\n${entries.length} rendered, ${failures} failed, ${totalKb.toFixed(0)} KB total`);
  console.log(`Index written to ${join(OUT_DIR, "index.json")}`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
