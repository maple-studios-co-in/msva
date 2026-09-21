import type { AnalyticsResponse, ChatResponse, ConversationState, DemoCall, LiveCallsResponse } from "@msva/shared";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4100";

// Calls, the text demo and the voice playground use paid speech and model services,
// so their routes need the console's session cookie.
export const SIGN_IN_REQUIRED = "Sign in to the console (/console.html) to use this.";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (response.status === 401) {
    throw new Error(SIGN_IN_REQUIRED);
  }
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

/** Whether this browser holds a console session. */
export async function consoleSignedIn(): Promise<boolean> {
  const response = await fetch(`${apiBase}/api/admin/me`, { credentials: "include" });
  return response.ok;
}

export function getAnalytics(): Promise<AnalyticsResponse> {
  return request<AnalyticsResponse>("/api/analytics");
}

export function getLiveCalls(
  filters: { from?: string; channel: LiveCallsResponse["channel"]; page: number; pageSize: number },
  signal?: AbortSignal
): Promise<LiveCallsResponse> {
  const params = new URLSearchParams({ channel: filters.channel, page: String(filters.page), pageSize: String(filters.pageSize) });
  if (filters.from) params.set("from", filters.from);
  return request<LiveCallsResponse>(`/api/live-calls?${params}`, { signal });
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
