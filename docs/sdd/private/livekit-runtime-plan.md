# REM-OPS runtime plan

Scope: Python worker, local runtime configuration, durable outbox, and deployment templates only.
No Node, Prisma, shared contract, browser, provider, carrier, or remote environment state is changed.

1. Lock and import-test Python 3.12 LiveKit Agents, Sarvam, Anthropic, HTTP client, and test stack.
2. Add a disabled-by-default worker which accepts only explicit `madhusudan-support-v1` dispatch.
3. Claim and renew a scoped API lease; persist final evidence before delivery and disable speech/tools
   on renewal loss or spool exhaustion.
4. Add private Redis/media/SIP-disabled composition plus worker health, drain, and rollback instructions.
5. Verify unit tests, canonical contract regression, import smoke, compile, diff hygiene, and compose parse
   where the Docker daemon allows it.
