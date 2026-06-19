# MSVA

Madhu Sudhan Voice Agent Platform MVP.

This monorepo contains a client-demo ready platform for a dairy-company inbound support voice agent. It includes a call analytics dashboard, dummy Hinglish voice-agent conversation flow, Ollama-backed local LLM integration, deterministic fallback responses, and developer/platform documentation.

## Apps

- `apps/api`: Express API + streaming voice agent (`streamChat`, SSE endpoint, tool registry).
- `apps/web`: React/Vite dashboard and demo UI.
- `apps/telephony`: Exotel webhook + media-stream WebSocket service. Pluggable ASR / TTS adapters.
- `packages/shared`: Shared TypeScript types.
- `data/reports.csv`: Provided call metadata copied into the project.
- `docs`: Product, architecture, developer, platform, and analysis docs.

## Quick Start

```bash
pnpm install
pnpm dev       # api + web
pnpm dev:all   # api + web + telephony (needed for the Live Call screen)
```

Default URLs:

- Web app: `http://localhost:5173`
- API: `http://localhost:4100`
- Telephony: `http://localhost:4200`
- Health: `http://localhost:4100/health`

## Talk to the agent (Live Call)

Open the web app, click **Live Call** in the sidebar, and press **Call** to have
a real, hands-free spoken conversation with the agent in the browser — you talk,
it transcribes, thinks, and talks back, and you can interrupt it mid-sentence.
This runs the same Sarvam ASR → agent → Sarvam TTS pipeline as a real phone
call, so it also works over Exotel/Twilio for actual PSTN calls.

Requires `SARVAM_API_KEY` in `apps/api/.env` and `apps/telephony/.env`, and
`pnpm dev:all`. Full guide (incl. real phone setup): [docs/live-call.md](docs/live-call.md).

## Ollama

The API defaults to:

```bash
OLLAMA_MODEL=qwen3.5:4b
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

If Ollama is unavailable, the demo still works through a deterministic fallback layer. For the best demo, keep Ollama running locally.

## Documentation

- [Project Brief](docs/project-brief.md)
- [Call Metadata Analysis](docs/call-metadata-analysis.md)
- [Architecture](docs/architecture.md)
- [Agent Streaming](docs/agent-streaming.md)
- [Live Call (browser + real phone)](docs/live-call.md)
- [Telephony](docs/telephony.md)
- [Calling Roadmap (master checklist)](docs/calling-roadmap.md)
- [Platform Features (Thinkly-inspired)](docs/platform-features.md)
- [Developer Guide](docs/developer-guide.md)
- [Platform Guide](docs/platform-guide.md)
- [Demo Script](docs/demo-script.md)
