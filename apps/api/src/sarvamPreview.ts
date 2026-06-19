// ---------------------------------------------------------------------------
// Sarvam TTS preview
//
// Used by the dashboard's Voice Playground panel. Given a voice + a phrase,
// hit Sarvam's REST TTS endpoint and return the audio (base64 WAV) along
// with sample rate, duration, and latency so the UI can display useful
// diagnostics next to the audio player.
//
// This is intentionally separate from apps/telephony/src/tts/sarvam.ts —
// the telephony adapter is a streaming PCM consumer; this is a single-shot
// "give me a clip I can play in the browser" helper. Same upstream API,
// different surface.
// ---------------------------------------------------------------------------

const SARVAM_BASE_URL = process.env.SARVAM_BASE_URL ?? "https://api.sarvam.ai";
const SARVAM_TTS_MODEL = process.env.SARVAM_TTS_MODEL ?? "bulbul:v3";
const SARVAM_PREVIEW_TIMEOUT_MS = Number(process.env.SARVAM_PREVIEW_TIMEOUT_MS ?? 8000);

/** Speakers available on bulbul:v3, surfaced to the UI as a grouped dropdown. */
export const BULBUL_V3_VOICES = {
  female: ["ritu", "priya", "neha", "pooja", "simran", "kavya", "ishita", "shreya"] as const,
  male: ["aditya", "ashutosh", "rahul", "rohan", "amit", "dev", "ratan", "varun", "manan"] as const
};

export type VoicePreviewRequest = {
  voice: string;
  text: string;
  language?: string;
};

export type VoicePreviewResponse = {
  audioBase64: string;
  contentType: "audio/wav";
  voice: string;
  language: string;
  text: string;
  latencyMs: number;
  bytes: number;
  sampleRate: number | null;
  durationMs: number | null;
  channels: number | null;
  bitsPerSample: number | null;
  requestId: string | null;
};

export type VoicePreviewError = {
  code:
    | "missing_key"
    | "invalid_request"
    | "sarvam_error"
    | "network"
    | "no_audio"
    | "timeout";
  status: number;
  message: string;
};

export async function previewVoice(
  req: VoicePreviewRequest
): Promise<{ ok: true; data: VoicePreviewResponse } | { ok: false; error: VoicePreviewError }> {
  const key = process.env.SARVAM_API_KEY;
  if (!key) {
    return {
      ok: false,
      error: {
        code: "missing_key",
        status: 503,
        message: "SARVAM_API_KEY is not set on the api service."
      }
    };
  }
  if (!req.voice || !req.text?.trim()) {
    return {
      ok: false,
      error: { code: "invalid_request", status: 400, message: "voice and text are required" }
    };
  }

  const language = req.language ?? "hi-IN";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SARVAM_PREVIEW_TIMEOUT_MS);
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(`${SARVAM_BASE_URL}/text-to-speech`, {
      method: "POST",
      signal: controller.signal,
      headers: { "api-subscription-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: req.text,
        target_language_code: language,
        model: SARVAM_TTS_MODEL,
        speaker: req.voice,
        speech_sample_rate: 22050 // pleasant for browser playback; pipeline uses 8000 for telephony
      })
    });
  } catch (error) {
    clearTimeout(timeout);
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      error: {
        code: aborted ? "timeout" : "network",
        status: 504,
        message: aborted
          ? `Sarvam request timed out after ${SARVAM_PREVIEW_TIMEOUT_MS}ms`
          : error instanceof Error
            ? error.message
            : "network error"
      }
    };
  }
  clearTimeout(timeout);

  if (!response.ok) {
    const body = await response.text();
    return {
      ok: false,
      error: {
        code: "sarvam_error",
        status: response.status,
        message: body.slice(0, 600)
      }
    };
  }

  const json = (await response.json()) as { audios?: string[]; request_id?: string };
  const audioBase64 = json.audios?.[0];
  if (!audioBase64) {
    return {
      ok: false,
      error: { code: "no_audio", status: 502, message: "Sarvam returned no audio payload" }
    };
  }

  const buf = Buffer.from(audioBase64, "base64");
  const wav = inspectWav(buf);

  return {
    ok: true,
    data: {
      audioBase64,
      contentType: "audio/wav",
      voice: req.voice,
      language,
      text: req.text,
      latencyMs: Date.now() - started,
      bytes: buf.byteLength,
      sampleRate: wav?.sampleRate ?? null,
      durationMs: wav?.durationMs ?? null,
      channels: wav?.channels ?? null,
      bitsPerSample: wav?.bitsPerSample ?? null,
      requestId: json.request_id ?? null
    }
  };
}

function inspectWav(buf: Buffer) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | null = null;
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
