# @msva/telephony

Per-call audio pipeline for the MSVA voice agent. Bridges a telephony provider (Exotel by default) to the streaming agent in `apps/api`.

## What it does

```
Caller ──► Exotel ──webhook──► /exotel/incoming ──ExoML──► Exotel
                                                              │
                                                       opens WSS
                                                              ▼
                                /voice ◄── 8kHz PCM ◄── Exotel
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
              ASR             endpointer (VAD)      barge-in
                │                  │
            final text       endpointed
                │                  │
                └──────► streamAgent (SSE → apps/api) ──► tokens
                                                              │
                                                              ▼
                                                            TTS
                                                              │
                                                       PCM ◄──┘
                                                       │
                                                       ▼
                                                /voice ──► Exotel ──► Caller
```

## Run locally

```bash
pnpm --filter @msva/api dev          # in one terminal
pnpm --filter @msva/telephony dev    # in another
```

The service listens on `http://localhost:4200` by default. Useful endpoints:

- `GET  /health` — sanity check, returns the public WS URL
- `POST /exotel/incoming` — Exotel webhook; returns ExoML
- `WSS  /voice?call=...&from=...&to=...` — media stream

## Env vars

| Var | Default | Notes |
|---|---|---|
| `TELEPHONY_PORT` | `4200` | HTTP + WS port |
| `PUBLIC_WS_HOST` | `127.0.0.1:4200` | What Exotel should connect to (use ngrok/Cloudflare Tunnel host in dev) |
| `PUBLIC_WS_SCHEME` | `ws` | `wss` once you're behind TLS |
| `AGENT_BASE_URL` | `http://127.0.0.1:4100` | Where `apps/api` is reachable |
| `AGENT_LANGUAGE` | `hi-IN` | Passed to ASR + TTS |
| `TTS_VOICE` | `meera` | Sarvam voice id |
| `SARVAM_API_KEY` | — | When set, ASR/TTS adapters use the real API instead of stubs |

## Connecting Exotel

1. In Exotel dashboard → App Bazaar → create a Voicebot Applet flow.
2. Set the URL to `https://<your-public-host>/exotel/incoming`.
3. Map the flow to one of your DIDs.
4. Expose this dev service via ngrok (`ngrok http 4200`) and set `PUBLIC_WS_HOST` to the ngrok host (without scheme). Set `PUBLIC_WS_SCHEME=wss`.

For Twilio replace `exomlForStream` with TwiML `<Connect><Stream>` and switch the media decoder from PCM to µ-law in `pipeline.ts` (the WS framing is otherwise nearly identical).

## Swapping ASR / TTS

The `src/asr/` and `src/tts/` folders define provider-agnostic interfaces. To wire a different provider:

1. Add `src/asr/<provider>.ts` exporting an `AsrFactory`.
2. Have it open the provider's streaming socket on construction, forward `feed()` calls, and emit `partial` / `final` events from the response stream.
3. Import it in `pipeline.ts` (or read `ASR_PROVIDER` env var) instead of `createSarvamAsr`.

Same shape for TTS. The pipeline never needs to change.

## Known limitations of the skeleton

- ASR and TTS are stubs that emit canned text and silent PCM. Real PCM and real transcripts arrive once `SARVAM_API_KEY` is set and the implementations are filled in.
- The endpointer is energy-based — fine for testing the loop, swap to Silero VAD before going live.
- The pipeline keeps conversation state in memory per WS. Production should persist it (Redis keyed on `callSid`) so a service restart mid-call can be recovered.
- Tool calls are synthesized deterministically from the inferred outcome. The next iteration should let the LLM emit JSON tool calls directly.
- No call recording / consent banner. Required before launching in India (DPDP Act + Exotel ToS).
