// ---------------------------------------------------------------------------
// Call log client
//
// Reports call lifecycle events (start / turn / end) to the API's internal
// routes so every call lands in the database. Fire-and-forget: a logging
// failure must never affect the live call, so errors are printed, not thrown.
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env.AGENT_BASE_URL ?? "http://127.0.0.1:4100";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN;

const REQUEST_TIMEOUT_MS = 3000;
const MAX_ATTEMPTS = 2;
// Only active chains are retained. Calls progress independently and an idle
// chain is removed even when no end event arrives (for example, a disconnect).
const pendingByCall = new Map<string, Promise<void>>();

async function post(path: string, body: unknown): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("request timed out"));
        }, REQUEST_TIMEOUT_MS);
      });
      const response = await Promise.race([
        fetch(`${API_BASE_URL}/api/internal${path}`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(INTERNAL_TOKEN ? { "x-internal-token": INTERNAL_TOKEN } : {})
          },
          body: JSON.stringify(body)
        }),
        timeout
      ]);
      // These endpoints finish their DB writes before sending headers. No
      // response payload is needed; never wait for a stalled error body.
      void response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        console.warn(`[calllog] ${path} → ${response.status}`);
        return;
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) {
        console.warn(`[calllog] ${path} failed`, error instanceof Error ? error.message : error);
        return;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function enqueue(callId: string, path: string, body: unknown): Promise<void> {
  const previous = pendingByCall.get(callId) ?? Promise.resolve();
  const pending = previous.then(() => post(path, body));
  pendingByCall.set(callId, pending);
  void pending.finally(() => {
    if (pendingByCall.get(callId) === pending) pendingByCall.delete(callId);
  });
  return pending;
}

export type CallStart = {
  id: string;
  startedAt?: string;
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
  start: (call: CallStart) => enqueue(call.id, "/calls/start", { ...call, startedAt: call.startedAt ?? new Date().toISOString() }),
  turn: (callId: string, turn: CallTurnReport) => enqueue(callId, `/calls/${encodeURIComponent(callId)}/turns`, turn),
  end: (callId: string, input: { status?: string; outcome?: string | null; endedAt?: string } = {}) =>
    enqueue(callId, `/calls/${encodeURIComponent(callId)}/end`, { ...input, endedAt: input.endedAt ?? new Date().toISOString() })
};
