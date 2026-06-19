import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Demo failsafe
//
// A pre-recorded agent clip the presenter can fall back to if the live
// pipeline (mic / ASR / LLM / TTS / telephony) misbehaves during a demo. The
// API owns both the audio bytes and the metadata so, to the browser, it looks
// exactly like first-party tool output (same origin, same response shapes) —
// not an external file someone is playing.
//
//   GET /api/voice-agent/demo-failsafe        → metadata (transcript, outcome…)
//   GET /api/voice-agent/demo-failsafe/audio  → the audio stream
// ---------------------------------------------------------------------------

export type DemoFailsafeConfig = {
  callerName: string;
  voice: string;
  transcript: string;
  outcome: string;
  collected: Record<string, string>;
  syntheticMetrics: {
    asrMs: number;
    llmFirstTokenMs: number;
    llmTotalMs: number;
    ttsFirstByteMs: number;
    ttfwMs: number;
  };
};

const CONFIG_PATH =
  process.env.DEMO_FAILSAFE_CONFIG ?? path.resolve(process.cwd(), "../../data/demo-failsafe.json");

export const DEMO_FAILSAFE_AUDIO_PATH =
  process.env.DEMO_FAILSAFE_AUDIO ?? path.resolve(process.cwd(), "assets/demo-failsafe.mp3");

let cached: DemoFailsafeConfig | null = null;

export function loadDemoFailsafe(): DemoFailsafeConfig | null {
  if (cached) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<DemoFailsafeConfig>;
    cached = {
      callerName: raw.callerName ?? "Madhusudan VA",
      voice: raw.voice ?? "neha",
      transcript: raw.transcript ?? "",
      outcome: raw.outcome ?? "resolved_by_va",
      collected: raw.collected ?? {},
      syntheticMetrics: {
        asrMs: raw.syntheticMetrics?.asrMs ?? 540,
        llmFirstTokenMs: raw.syntheticMetrics?.llmFirstTokenMs ?? 410,
        llmTotalMs: raw.syntheticMetrics?.llmTotalMs ?? 1180,
        ttsFirstByteMs: raw.syntheticMetrics?.ttsFirstByteMs ?? 620,
        ttfwMs: raw.syntheticMetrics?.ttfwMs ?? 820
      }
    };
  } catch {
    cached = null;
  }
  return cached;
}

export function demoFailsafeAvailable(): boolean {
  return loadDemoFailsafe() !== null && fs.existsSync(DEMO_FAILSAFE_AUDIO_PATH);
}
