# Delivery plan

Sequenced so that every stage ends with something demonstrable, tested and
documented. Order is chosen by what unblocks what, not by what is interesting.

## Working rules

These apply to every item below, and are the reason the sequence is slower and
sturdier than a feature list.

- **Test first.** A change lands with tests that would fail without it.
- **Docs as we go.** A stage is not done until the doc explaining it is
  written. Architecture notes live in `docs/`, next to this file.
- **Security reviewed per stage**, not once at the end. Each stage below names
  its own security work rather than deferring it.
- **Cleanup is part of the work, not a later project.** Every stage carries an
  explicit cleanup item. Stubs that report success without doing anything are
  treated as defects, not as scaffolding.
- **No stub reaches a live caller.** Anything that cannot really do its job
  must say so out loud rather than returning a cheerful result.

## Stage 0 — Foundations (done)

Test runner across the workspace. Exotel wire protocol covered by tests. A WAV
module that refuses formats it cannot handle instead of producing noise. The
call simulator. Fixed call lines served from pre-rendered audio.

## Stage 1 — Make the line real and safe to answer

Nothing else matters until a real call can land and be handled honestly.

1. **Exotel account, KYC, applet enablement, number.** Start immediately, it is
   the long pole and it is external. Decide whose account and whose KYC first.
2. **Warm transfer for real.** Today it reports success without dialling
   anyone. The proposal promises food-safety and angry callers reach a human.
   Until this is real, no live traffic.
3. **Console sign-in by email.** Codes only reach the server log, so nobody at
   the client can log in. Security work in this stage: rate limit code
   requests, confirm expiry and single use, review session cookie flags.
4. *Cleanup:* replace the single in-flight lock in the pipeline with a real
   per-call queue. It is a known shortcut and it will not survive two callers.

## Stage 2 — Harden before traffic

5. **Security pass on the whole surface.** Rotate the internal service token,
   review admin route authorisation per role, confirm the audit log covers
   every mutation, check no secret reaches a client bundle or a log line.
6. **Structured logging and error reporting**, so a failed call is
   diagnosable after the fact rather than by re-running it.
7. **Concurrency and multi-line.** Several callers at once, with the queue from
   stage 1 under load.
8. *Cleanup:* remove the demo-only failsafe paths from the production build.

## Stage 3 — Inside their systems

9. **Distributor and retailer master import**, which is what caller
   recognition actually requires.
10. **ERP read-only adapter** behind an interface, with a fake implementation
    so tests never depend on their systems being up.
11. **Real WhatsApp confirmation.** Another stub that currently reports
    success. Same rule as warm transfer.
12. **Ops dashboard on live call data**, replacing the sample spreadsheet the
    analytics view still reads.
13. *Cleanup:* delete the CSV analytics path once the live one is trusted.

## Stage 4 — Beyond the phone

14. WhatsApp ordering for the trade.
15. Farmer helpline.
16. Proactive outbound calls.

## Known shortcuts, carried openly

Listed so they are decisions rather than surprises.

- Warm transfer and WhatsApp confirmation are stubs that report success.
- The pipeline serialises turns with a single boolean lock.
- The analytics view reads a sample spreadsheet, not the database.
- Login codes are written to the server log because no sender is configured.
- Demo data, when seeded, is not marked as test data, because the overview
  deliberately excludes test calls.
