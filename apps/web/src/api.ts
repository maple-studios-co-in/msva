import type { AnalyticsResponse, ChatResponse, ConversationState, DemoCall } from "@msva/shared";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4100";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getAnalytics(): Promise<AnalyticsResponse> {
  return request<AnalyticsResponse>("/api/analytics");
}

export function getDemoCalls(): Promise<DemoCall[]> {
  return request<DemoCall[]>("/api/demo-calls");
}

export function getInitialState(callId: string): Promise<ConversationState> {
  return request<ConversationState>(`/api/demo-calls/${callId}/state`);
}

export function sendMessage(callId: string, message: string, state: ConversationState): Promise<ChatResponse> {
  return request<ChatResponse>("/api/voice-agent/chat", {
    method: "POST",
    body: JSON.stringify({ callId, message, state })
  });
}

// ---------------------------------------------------------------------------
// Voice playground
// ---------------------------------------------------------------------------

export type VoiceCatalog = {
  model: string;
  keyConfigured: boolean;
  voices: { female: string[]; male: string[] };
};

export type VoicePreview = {
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

export function getVoiceCatalog(): Promise<VoiceCatalog> {
  return request<VoiceCatalog>("/api/voice-agent/voices");
}

export function previewVoice(voice: string, text: string, language = "hi-IN"): Promise<VoicePreview> {
  return request<VoicePreview>("/api/voice-agent/tts-preview", {
    method: "POST",
    body: JSON.stringify({ voice, text, language })
  });
}

// ---------------------------------------------------------------------------
// Demo failsafe — pre-recorded clip served first-party by the API.
// ---------------------------------------------------------------------------

export type DemoFailsafe = {
  available: boolean;
  callerName?: string;
  voice?: string;
  transcript?: string;
  outcome?: string;
  collected?: Record<string, string>;
  syntheticMetrics?: {
    asrMs: number;
    llmFirstTokenMs: number;
    llmTotalMs: number;
    ttsFirstByteMs: number;
    ttfwMs: number;
  };
  audioUrl?: string;
};

export function getDemoFailsafe(): Promise<DemoFailsafe> {
  return request<DemoFailsafe>("/api/voice-agent/demo-failsafe");
}

// ---------------------------------------------------------------------------
// AI brain mode — toggle the real LLM vs instant deterministic replies.
// ---------------------------------------------------------------------------

export type LlmMode = { enabled: boolean; model: string };

export function getLlmMode(): Promise<LlmMode> {
  return request<LlmMode>("/api/voice-agent/llm-mode");
}

export function setLlmMode(enabled: boolean): Promise<LlmMode> {
  return request<LlmMode>("/api/voice-agent/llm-mode", {
    method: "POST",
    body: JSON.stringify({ enabled })
  });
}

export function failsafeAudioUrl(): string {
  return `${apiBase}/api/voice-agent/demo-failsafe/audio`;
}
