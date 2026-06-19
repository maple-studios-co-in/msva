import type { ChatStreamEvent, ConversationState } from "@msva/shared";

// ---------------------------------------------------------------------------
// Agent client
//
// Thin SSE consumer for the API's `/api/voice-agent/chat/stream` endpoint.
// Yielding `ChatStreamEvent`s lets the telephony pipeline pipe tokens
// straight into the TTS adapter without buffering the full reply.
// ---------------------------------------------------------------------------

const AGENT_BASE_URL = process.env.AGENT_BASE_URL ?? "http://127.0.0.1:4100";

export async function* streamAgent(
  callId: string,
  message: string,
  state?: ConversationState
): AsyncGenerator<ChatStreamEvent, void, void> {
  const response = await fetch(`${AGENT_BASE_URL}/api/voice-agent/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ callId, message, state })
  });

  if (!response.ok || !response.body) {
    yield { type: "error", message: `Agent returned ${response.status}` };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by blank lines.
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          yield JSON.parse(line.slice("data: ".length)) as ChatStreamEvent;
        } catch {
          // ignore malformed SSE frame
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
