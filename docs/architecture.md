# MSVA Architecture

## System Purpose

MSVA is an MVP platform that demonstrates how Madhu Sudhan can place an AI voice layer in front of its manual inbound support process.

The MVP proves four things:

1. Call metadata can be converted into operational insights.
2. A voice agent can handle the first conversation in Hinglish.
3. Routine calls can be resolved or converted into callback tickets.
4. Sensitive calls can be escalated to human agents with structured context.

## Monorepo Layout

```text
MSVA/
  apps/
    api/                 Express API + streaming voice agent
    web/                 React dashboard
    telephony/           Telephony service (Exotel webhook + media-stream WS)
  packages/
    shared/              Shared TypeScript types
  data/
    reports.csv          Source call metadata
  docs/
    architecture.md
    agent-streaming.md
    telephony.md
    calling-roadmap.md
    developer-guide.md
    platform-guide.md
    demo-script.md
    call-metadata-analysis.md
    project-brief.md
```

## Runtime Architecture

```text
Inbound Caller
   |
   v
Exotel (or Twilio / Plivo)
   | webhook
   v
apps/telephony  /exotel/incoming  → returns ExoML with <Stream>
   | media-stream WebSocket (8kHz PCM)
   v
apps/telephony  pipeline
   +--> Endpointer (VAD) → barge-in
   +--> ASR adapter (Sarvam / Bhashini / Deepgram)
   |
   |   final transcript
   v
apps/api  POST /api/voice-agent/chat/stream  (Server-Sent Events)
   +--> streamChat() async generator
   |    +--> Streaming Ollama (NDJSON deltas)
   |    +--> Deterministic fallback when model is unavailable
   |    +--> Tool registry + dispatch
   |
   |   token + tool_call + tool_result + final events
   v
apps/telephony  pipeline
   +--> TTS adapter (streaming PCM) → media frames back to Exotel
   +--> CallTurn telemetry (asrMs, llmFirstTokenMs, ttsFirstByteMs, …)
   +--> Warm transfer on tool_result(transfer_to_human)
   |
   v
Tools
   +--> Helpdesk (Freshdesk / Zoho)
   +--> OMS / DMS / Warehouse
   +--> WhatsApp Business API
   +--> Human agent queue (warm transfer)
   |
   v
Analytics Dashboard (apps/web)
   +--> Historical call CSV (current)
   +--> Live calls + per-turn latencies (planned)
```

The MVP implements the streaming decision layer end-to-end, plus a telephony service skeleton with stubbed ASR/TTS. Real provider wiring, CRM/ERP integration, and the live-calls dashboard view are tracked in [calling-roadmap.md](./calling-roadmap.md).

## API Components

### Analytics Service

File: `apps/api/src/analytics.ts`

Responsibilities:

- Load `data/reports.csv`.
- Normalize call records.
- Calculate total calls, answer rate, missed/unanswered demand, repeat caller load, time-band metrics, agent load, and daily trends.
- Expose dashboard-ready JSON through `GET /api/analytics`.

### Demo Call Service

File: `apps/api/src/demoCalls.ts`

Responsibilities:

- Provide dummy calls for distributor, retailer, and customer scenarios.
- Define expected outcomes: resolved by VA, ticket created, or human transfer.
- Seed the voice-agent demo with realistic Hinglish call contexts.

### Voice Agent Service (streaming)

File: `apps/api/src/voiceAgent.ts`

Responsibilities:

- Initialize conversation state.
- Keep conversation history.
- Collect basic fields from caller messages and apply escalation rules.
- Stream from Ollama (NDJSON `/api/chat?stream=true`) and yield token deltas.
- Fall back to deterministic scripted responses when the model is unavailable.
- Synthesize tool calls (`create_ticket`, `transfer_to_human`, `check_inventory`) and dispatch them through `tools/`.

Primary entry point is `streamChat(callId, message, state)` — an async generator that yields a sequence of `ChatStreamEvent`s (`token`, `tool_call`, `tool_result`, `final`, `error`). A backward-compatible `handleChat()` drains the stream into the legacy `ChatResponse` shape. See [agent-streaming.md](./agent-streaming.md) for the contract.

### Tools

Folder: `apps/api/src/tools/`

- `index.ts` — registry + `dispatchTool(callId, call)` switchboard.
- `crm.ts` — stubs for `lookup_order`, `create_ticket`, `check_inventory`, `send_whatsapp_confirmation`.
- `transfer.ts` — `transfer_to_human` stub. In production the telephony layer listens for the matching `tool_result` event and issues a warm transfer.

### Telephony Service

App: `apps/telephony` (see [telephony.md](./telephony.md))

Responsibilities:

- Receive Exotel inbound webhook at `POST /exotel/incoming` and reply with ExoML pointing at a media-stream WebSocket.
- Accept the WS upgrade at `/voice`, parse Exotel framing.
- Run the per-call pipeline: PCM → endpointer + ASR → SSE call to `apps/api` → TTS → PCM back to Exotel.
- Cancel TTS and clear Exotel's playback queue when the caller barges in.
- Emit warm-transfer commands when `tool_result(transfer_to_human)` arrives.
- Capture per-turn latency in `CallTurn` records for the analytics dashboard.

## Frontend Components

File: `apps/web/src/App.tsx`

The MVP has three screens:

- Call Analytics: KPIs, status split, time bands, repeat calls, agent load.
- VA Demo: Dummy call selector, Hinglish conversation simulator, handoff summary.
- Platform Flow: End-to-end flow and platform capability cards.

## LLM Strategy

Default local model:

```text
qwen3.5:4b
```

Reasoning:

- Already available locally in Ollama.
- Suitable for low-latency demo conversations.
- Strong multilingual/Hinglish behavior for a small local model.
- Keeps client demo independent from external model APIs.

Fallback:

- If Ollama fails, the API returns deterministic responses.
- This keeps the client demo stable even if the model server is stopped.

## Escalation Policy

The MVP escalates when:

- Caller asks for a human.
- Caller reports product quality or food safety concern.
- Caller has invoice/payment dispute.
- Intent is unclear.
- Backend data would be required but is unavailable.

Production policy should add:

- Sentiment detection.
- Caller priority tier.
- Repeat unresolved ticket logic.
- Agent availability.
- SLA rules.

## Production Integration Points

### Telephony

Required capabilities:

- Inbound call webhook.
- Live audio streaming or call media bridge.
- Call transfer.
- Call recording.
- Call metadata events.

Candidates:

- Exotel.
- Knowlarity.
- Twilio.
- Plivo.
- Airtel IQ.

### Speech-to-Text and Text-to-Speech

Production needs:

- Hindi/Hinglish accuracy.
- Low latency.
- Noise tolerance.
- Streaming partial transcripts.
- Natural Indian voice.

### CRM / Ticketing

Required fields:

- Caller phone.
- Caller type.
- Intent.
- Collected details.
- Urgency.
- AI summary.
- Escalation reason.
- Recording/transcript URL.

### ERP / Order System

Needed for full automation:

- Distributor lookup.
- Order status.
- Invoice status.
- Delivery ETA.
- Product availability.
- Credit note/payment state.

## Data Model Direction

Production entities:

- Caller.
- Organization or distributor account.
- Call session.
- Conversation turn.
- Intent.
- Ticket.
- Handoff.
- Knowledge article.
- Integration event.

## Security and Compliance Notes

Production version should include:

- PII encryption at rest.
- Role-based dashboard access.
- Audit logs for human handoff.
- Data retention policy for recordings and transcripts.
- Consent and AI disclosure policy.
- Secrets management through environment variables or vault.

## Scaling Direction

The MVP is a simple API plus frontend. Production should separate:

- Telephony gateway.
- Conversation orchestrator.
- LLM service.
- Analytics service.
- Integration worker.
- Database.
- Queue.

This allows call handling to remain low-latency while slower tasks such as ticket creation, callbacks, and analytics run asynchronously.
