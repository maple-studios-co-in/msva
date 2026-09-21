# REM-OPS decision ledger

| Decision | Evidence | Consequence |
| --- | --- | --- |
| Standard `AgentServer` plus one `AgentSession` | Locked `livekit-agents==1.8.2` imports and official server/session APIs | No legacy Node chat controller in the worker call path. |
| Explicit dispatch only | `madhusudan-support-v1` is checked in the request handler and lease claim | The worker does not accept arbitrary room work. |
| Server-created call identifier | Dispatch metadata is exact JSON `{callId}` and API repeats all binding checks | No room-name-derived call ownership. |
| SQLite WAL spool | Tests prove restart retention, idempotent IDs, bounded capacity and delayed retry | Evidence is committed before delivery; no raw audio/header storage. |
| Sarvam realtime STT | The resolved `livekit-plugins-sarvam==1.8.2` imports `STTRealtime` and `TTS` under Python 3.12 | Runtime remains disabled unless `VOICE_STT_MODE=realtime` and a provider entitlement probe are configured. |
| Optional SIP | SIP is a disabled host-network compose profile | No carrier configuration or claim of SIP readiness. |
| Self-hosted session revocation | Local `v1.13.7` probe showed refreshed grants can reconnect after application revocation | Raw signal/admin `:7880` remains private; browsers require a fail-closed application signaling proxy. |
