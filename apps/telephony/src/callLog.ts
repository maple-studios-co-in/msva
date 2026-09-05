// ---------------------------------------------------------------------------
// Call log client
//
// Reports call lifecycle events (start / turn / end) to the API's internal
// routes so every call lands in the database. Fire-and-forget: a logging
// failure must never affect the live call, so errors are printed, not thrown.
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env.AGENT_BASE_URL ?? "http://127.0.0.1:4100";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;

async function post(path: string, body: unknown): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/internal${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {})
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      console.warn(`[calllog] ${path} → ${response.status} ${await response.text().catch(() => "")}`);
    }
  } catch (error) {
    console.warn(`[calllog] ${path} failed`, error instanceof Error ? error.message : error);
  }
}

export type CallStart = {
  id: string;
  provider: "browser" | "exotel" | "twilio";
  providerSid?: string | null;
  fromNumber: string;
  toNumber?: string | null;
  callerName?: string | null;
  callerType?: string | null;
  isTest?: boolean;
  agentSlug?: string | null;
  language?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type CallTurnReport = {
  index: number;
  callerText?: string | null;
  replyText?: string | null;
  asrMs?: number | null;
  llmFirstTokenMs?: number | null;
  llmTotalMs?: number | null;
  ttsFirstByteMs?: number | null;
  ttfwMs?: number | null;
  interrupted?: boolean;
  source?: string | null;
  toolCalls?: unknown;
  outcome?: string | null;
  collected?: Record<string, string> | null;
  escalationReason?: string | null;
  intent?: string | null;
};

export const callLog = {
  start: (call: CallStart) => post("/calls/start", call),
  turn: (callId: string, turn: CallTurnReport) => post(`/calls/${encodeURIComponent(callId)}/turns`, turn),
  end: (callId: string, input: { status?: string; outcome?: string | null } = {}) =>
    post(`/calls/${encodeURIComponent(callId)}/end`, input)
};
