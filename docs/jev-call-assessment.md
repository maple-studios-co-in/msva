# Optional Jev post-call assessment

This optional, supervisor-initiated feature assesses a completed call's saved
utterances. It sends a minimized, speaker-labelled transcript to TypeSafe AI
only after a supervisor uses the authenticated console action. It is disabled
by default and does not change call outcomes, tickets, routing, callbacks, or
operational metrics.

Set all three server-side variables to enable it:

- `JEV_ENABLED=true`
- `JEV_API_KEY`
- `JEV_ALLOWED_ORIGINS`, an exact comma-separated list of console origins

Before enabling it, apply the database migration and restart the API with those
server-side values. `JEV_ALLOWED_ORIGINS` must list the exact deployed console
origins; it is not inferred from request headers. A real key is not included in
this repository. Offline fixtures only verify the integration plumbing, so
provider quality, latency, and real-world classifications remain unvalidated.

Automatic post-call assessment is separately disabled by default. To enable
it after the manual capability above is configured, set
`JEV_AUTO_POST_CALL_ENABLED=true` and `JEV_AUTO_START_AT` to an ISO timestamp.
Only calls completed on or after that time are queued. The durable queue waits
briefly for final transcript/ticket writes, has two shared execution slots and
at most three automatic provider attempts per unchanged input. It never delays
call logging, bulk-enqueues history at boot, or changes manual POST behavior.

The browser never receives the API key. The service uses the fixed TypeSafe AI
endpoint and pinned `jev-1.13.0` model. Saved utterances are ordered by sequence,
redacted for known names, phone numbers, and email-shaped strings, and rejected
when empty or over 24,000 characters. This reduces data exposure but cannot
guarantee that arbitrary spoken personal information is removed.

`GET /api/admin/calls/:id/assessment` is available to authenticated viewers
and never invokes the provider. `POST` requires a supervisor or admin, an exact
allowlisted Origin, and an empty JSON object. A current saved result is reused;
an active lease returns pending; failed or interrupted work may be retried after
the bounded cooldown or lease expiry.

Results are advisory model classifications. `possible_safety` means “Possible
safety concern — review”; it is not a diagnosis, SOS detector, or automatic
alert. A claimed ticket without a linked persisted ticket is a possible wording
or evidence mismatch, not proof of a false promise. No real provider request
is made when configuration is absent, and automated tests use no vendor call.
