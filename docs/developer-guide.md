# MSVA Developer Guide

## Prerequisites

- Node.js 22+
- pnpm 10+
- Ollama 0.24+ recommended

## Install

```bash
pnpm install
```

## Run Locally

```bash
pnpm dev
```

This starts:

- API on `http://localhost:4100`
- Web on `http://localhost:5173`

## Environment

Copy the API example env if you want local overrides:

```bash
cp apps/api/.env.example apps/api/.env
```

Variables:

```bash
PORT=4100
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:4b
CSV_PATH=../../data/reports.csv
```

## Scripts

```bash
pnpm build       # Build all packages
pnpm typecheck   # Typecheck all packages
pnpm dev:api     # API only
pnpm dev:web     # Web only
```

## API Endpoints

### Health

```http
GET /health
```

Returns service status, selected model, and loaded record count.

### Analytics

```http
GET /api/analytics
```

Returns dashboard metrics:

- KPIs.
- Status split.
- Time-band metrics.
- Repeat caller metrics.
- Agent load.
- Daily trend.
- Findings.

### Reload Analytics

```http
POST /api/analytics/reload
```

Reloads `data/reports.csv` without restarting the API.

### Demo Calls

```http
GET /api/demo-calls
```

Returns dummy call scenarios.

### Initial Conversation State

```http
GET /api/demo-calls/:id/state
```

Returns a seeded conversation state for one dummy call.

### Voice Agent Chat

```http
POST /api/voice-agent/chat
```

Body:

```json
{
  "callId": "call-dist-delivery-delay",
  "message": "Mera order kal aana tha par abhi tak nahi aaya",
  "state": {}
}
```

Response:

```json
{
  "reply": "Aap order ya invoice number bata dijiye...",
  "state": {},
  "model": "qwen3.5:4b",
  "source": "ollama"
}
```

`source` becomes `fallback` if Ollama is unavailable.

## Adding a New Demo Call

Edit:

```text
apps/api/src/demoCalls.ts
```

Add a `DemoCall` object with:

- `id`
- `callerName`
- `phone`
- `callerType`
- `intent`
- `language`
- `urgency`
- `transcriptSeed`
- `expectedOutcome`

## Changing Escalation Logic

Edit:

```text
apps/api/src/voiceAgent.ts
```

Main functions:

- `inferState`: deterministic field collection and escalation.
- `fallbackReply`: stable demo replies.
- `ollamaReply`: model prompt and generation settings.

## Changing Analytics

Edit:

```text
apps/api/src/analytics.ts
```

The CSV loader maps raw columns into `CallRecord`. Dashboard calculations are returned from `buildAnalytics`.

## Frontend Structure

```text
apps/web/src/
  App.tsx        Main screens and components
  api.ts         API client
  styles.css    App styles
  main.tsx      React entry
```

## Build Verification

Before demo:

```bash
pnpm build
curl http://localhost:4100/health
```

Open:

```text
http://localhost:5173
```

## Known MVP Limits

- No real telephony integration yet.
- No database yet; CSV and in-memory state only.
- No real CRM/ERP lookup.
- No authentication.
- No persistent call transcripts.
- No production-grade STT/TTS.

These are intentional for the first client-demo MVP.
