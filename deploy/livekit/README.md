# MSVA LiveKit runtime

This is a disabled-by-default self-hosted pilot template. It starts a private Redis and a
pinned LiveKit server only after an operator has supplied a secret-backed `.env`; the Python
worker is an explicit `voice` profile. Redis, the worker health port, and raw LiveKit signaling/
admin `:7880` are not published.

The worker needs the durable MSVA voice-service routes before it can accept a call. It connects to
the private `ws://livekit:7880` endpoint, while browsers must use a separate application-controlled
signaling proxy at `LIVEKIT_PUBLIC_URL`. Its first
operation is a global-credential lease claim bound to the server-created dispatch metadata,
room, dispatch ID, and actual LiveKit agent identity. It then uses only the returned call-scoped
lease token for context, events, renewal, and tools. Missing configuration or an unsupported
realtime STT adapter leaves the worker off; it never falls back to the legacy chat endpoint.

## Deliberate runtime limits

- `livekit/livekit-server:v1.13.7` is the selected media-server release. Record the pulled
  image digest in the deployment evidence before promotion.
- Python dependencies are resolved in `apps/voice-agent/uv.lock` under Python 3.12. The actual
  locked `livekit-plugins-sarvam==1.8.2` imports `sarvam.STTRealtime` and `sarvam.TTS`; enabling
  requires explicit `VOICE_STT_MODE=realtime` and a separate Sarvam entitlement probe.
- The worker has a two-call cap, one idle-process default is deliberately left to LiveKit only
  after host measurement, a 120-second drain, 30-second lease, and 10-second renewal interval.
- SQLite WAL on the `voice-spool` volume persists final event/tool evidence before delivery.
  It is bounded to 10,000 events / 50 MiB; capacity is an admission failure, not a data drop.

## Local preparation only

Copy `env.example` to `.env`; do not change `VOICE_RUNTIME_ENABLED=false` while the service
contracts are absent. Once the API implementation and a non-production secret store exist,
set every required value and use `VOICE_STT_MODE=realtime` only after the entitlement probe.

```sh
docker compose --env-file .env -f deploy/livekit/compose.yaml config
docker compose --env-file deploy/livekit/.env -f deploy/livekit/compose.yaml up -d redis livekit
# Worker remains opt-in and requires live service contracts. Always run the replay
# companion with it: it is the one process that delivers call evidence.
docker compose --env-file deploy/livekit/.env -f deploy/livekit/compose.yaml --profile voice up -d voice-agent voice-replay
```

`voice-replay` shares the worker's spool volume and delivers everything the worker persists,
during a call and after it (an API outage, a worker restart), using only each event's retained
per-call credential. A call only appends; when it ends it waits briefly for its evidence to be
delivered. The companion needs `VOICE_INTERNAL_API_URL` and `VOICE_REPLAY_CREDENTIAL_KEY`, not
LiveKit or provider secrets, and keeps running when `VOICE_RUNTIME_ENABLED=false`.

Evidence the API refuses for one of its own reasons stops that call's stream; the call's worker
then ends AI authority, and the stop is logged. Other refusals (an HTML 404 from a misrouted
`VOICE_INTERNAL_API_URL`, a proxy error) are retried and logged. Once a cause is fixed, retry
stopped streams with `docker compose ... run --rm voice-replay uv run --frozen python -m
madhusudan_voice.replay clear-faults [CALL_ID]`. Anything older than the API's replay window is
dropped and logged as unrecoverable.

A replay key that cannot read the spool stops the worker and the companion at start instead of
stopping every stream. To rotate the key, set `VOICE_REPLAY_CREDENTIAL_KEY=new,old` (the first
key encrypts, any decrypts) and remove the old key once the replay window has passed.

The configuration renderer creates `/run/livekit/livekit.yaml` at startup from secret-store
environment values with mode `0600`; it accepts only the documented LiveKit token alphabet
(`A-Z`, `a-z`, `0-9`, `_`, `-`) so it can emit safe YAML scalars without logging credentials.
The checked-in file contains no literal `$` credential placeholders. The worker receives a separate egress network for the MSVA API and providers; in
production, host egress policy must restrict it to the MSVA API, Sarvam, and Anthropic over
approved DNS/TLS destinations. Raw LiveKit signaling/admin `:7880` remains private.

The private Compose template disables LiveKit automatic external-IP discovery because its
internal media network intentionally has no STUN/DNS egress. It is not a public-media topology.
`LIVEKIT_NODE_IP` is required and passed to LiveKit's supported `--node-ip` flag. Before enabling public media, set a reviewed explicit advertised node IP in the production
configuration and approve the corresponding UDP/TCP, TURN, and firewall policy; do not expose
raw signaling/admin `:7880` to solve discovery.

Do not publish raw `:7880` through Caddy/nginx or directly on a host. A local permission probe
showed that a self-hosted LiveKit refreshed token can reconnect with newly granted permissions after
application-session revocation. The Node admission proxy must verify every signaling connection and
reconnect against live MSVA session/call/ownership state, remove active participants on revocation,
and fail closed for an unavailable verifier. UDP/TCP media remains LiveKit, but a client cannot
negotiate media without admitted signaling. This proxy is an API/browser follow-up, not implemented
by this operations slice.

## Readiness, drain, rollback

`voice-agent` exposes the Agents framework health endpoint on its private `8081`; it returns
healthy only after the worker has connected to LiveKit. Readiness for a release also requires
the API health, a sanitized provider capability probe, and spool headroom. A `SIGTERM` causes
the server to drain existing jobs for up to 120 seconds (Compose allows 130 seconds before
killing the container); the worker stops new admission through
LiveKit and loses speech/tool authority immediately when lease renewal fails.

To roll back a worker release: stop new browser admission in the Node service, send the worker
`SIGTERM`, wait for the drain or record the outstanding call state, retain the named spool volume,
then deploy the previous verified worker image. Do not delete Redis or the spool volume as part
of rollback. The existing Exotel media-stream route remains separately operated fallback.

## SIP profile

`sip` is intentionally an unsupported `sip-unimplemented` profile using `livekit/sip:v1.13.0`.
Host networking is required for public RTP/SIP ranges but cannot use Docker's private Redis DNS.
No trunk, dispatch rule, provider configuration, or call is created here. It remains disabled until
a carrier/firewall/DNS runbook and rendered SIP configuration exist.
