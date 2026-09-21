# REM-OPS handoff brief

The runtime needs the Node voice service to provide the lease claim, context, renewal, event, and
tool routes described in `/tmp/msva-voice-service-brief.md`. Dispatch metadata must be the exact
server-created object `{callId}`. Context must bind the room, current epoch, caller identity,
actual agent identity, language, permitted tools, and minimal prompt/context. The runtime sends
all event payloads through the durable spool and treats interim captions as non-durable.

Remaining gates: generated voice-v1 schemas, API implementation, authenticated browser token and
dispatch creation, a provider capability test, trusted DNS/TLS/TURN/public IP, local media test,
and separate carrier/SIP authorization. No test in this scope proves browser audio or PSTN service.
Raw self-hosted LiveKit signaling is not a browser endpoint: the browser integration must add the
application-controlled signaling proxy specified in `/tmp/msva-livekit-admission-finding.md`.
