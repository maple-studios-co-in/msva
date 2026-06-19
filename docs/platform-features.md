# Platform features — inspired by Thinkly

A catalog of features visible in the Thinkly Voice AI screenshots, mapped to MSVA's current state, with a priority recommendation for each. Items chosen for adoption get ported into [calling-roadmap.md](./calling-roadmap.md) as checklist items in the appropriate phase.

This isn't a feature-copy exercise — it's a "what does a mature voice-agent platform actually look like" reference. Some Thinkly features map cleanly onto our roadmap; others fit a different shape for dairy distribution and should be reinterpreted, not cloned.

---

## Tier 1 — Adopt now (high-leverage, fits MSVA)

### 1. Call detail drawer with four tabs

**Thinkly:** clicking a call in the history opens a right-side drawer with `Call Details / Profile / Performance / Step Breakdown` tabs. Each call becomes an inspectable artifact, not just a row.

**MSVA today:** none. Past calls have no detail view — only the four scripted demo calls have any structure, and that ends when the conversation does.

**What to build:**
- Slide-out drawer over the call-history table
- Tabs as four React routes within the drawer: `details`, `profile`, `performance`, `steps`
- Header shows caller name, phone, status badge, lead source, time ago

**Why first:** this is the UI shell every subsequent feature (profile extraction, performance scoring, step breakdown) lives inside. Build the shell first so the rest plug in without dashboard refactors.

### 2. AI-extracted profile fields per call

**Thinkly:** each call has a structured profile with fields like `HAS_FACEBOOK: true`, `PRODUCT_CATEGORIES: clothing, jewellery`, `FACEBOOK_FOLLOWERS: 2310`, `CALLBACK_TIME: Evening after 6 PM`, `PLATFORMS_RAW: "Owns a Facebook page, plans to start YouTube"`. The schema is per-agent — the seller-onboarding agent extracts seller-platform fields, a delivery-issue agent would extract order/SKU fields.

**MSVA today:** we collect three or four regex-matched fields (`issue`, `reference`, `location`) into `ConversationState.collected`. No LLM extraction, no per-agent schema.

**What to build:**
- A post-call extraction pass: send the full transcript + a per-agent schema to a small LLM (Haiku or Qwen) with structured output enabled
- Store the result alongside the call (Postgres JSONB column)
- Schema lives with the voice agent definition — every field has a label, type (string/bool/int), and an optional enum of accepted values
- Render each field as a card in the Profile tab

**Why valuable:** this is the difference between "we recorded a call" and "we know the customer." It also unlocks downstream automation — when `RED_FLAG_CATEGORY` is set the call routes to QA, when `CALLBACK_TIME` is set we schedule one automatically.

### 3. Performance scoring (post-call judge)

**Thinkly:** every call gets scored 0–10 on `AGENT_TONE`, `SCRIPT_ADHERENCE`, `CROSS_SELL`, `FAQ_ACCURACY` with a critical/target/optimal bar. Looks like a separate LLM "judge" pass over the transcript.

**MSVA today:** none. We have no way to know whether the agent is performing well or drifting.

**What to build:**
- Per-agent rubric (each metric: name, prompt for the judge, target/optimal thresholds)
- Post-call judge LLM pass that scores each rubric item against the transcript and returns a number plus a one-line justification
- Store scores alongside the call
- Render in the Performance tab as horizontal bars with the same critical/target/optimal markers

**Why valuable:** without this we can't tell a prompt regression from a model regression from a real-world distribution shift. It's the foundation of any A/B framework on prompts or models — and the calling roadmap already lists "prompt versioning + A/B framework" as needing this.

### 4. Call recording + bilingual transcript

**Thinkly:** a `CALL_RECORDING` card with an audio player (HTML5 `<audio>` with scrubber, duration, download button). Below it a `TRANSCRIPT` section with speaker bubbles, copy-per-bubble, and mixed Devanagari + Latin script (Hinglish).

**MSVA today:** none — we don't record, don't store transcripts long-term.

**What to build:**
- Record every call's PCM stream to S3 / R2 as WAV (or Opus if cost matters)
- Store the time-aligned transcript with per-utterance speaker tags
- Drawer renders the audio player + bubble transcript with copy buttons
- **Critical:** consent line in the opening greeting before this ships ("Yeh call recorded ho rahi hai...")

**Why valuable:** debugging without recordings is guessing. QA without transcripts is impossible. This is also a hard precondition for the performance-scoring judge above — the judge needs the transcript to score against.

### 5. Qualification signals + Next Steps

**Thinkly:** the Call Details tab shows green "Qualification Signals" pills ("Interested in increasing income through Zoop.", "Wants to start live selling again.") and a numbered "Next Steps" list ("Schedule follow-up call", "Confirm suitable time"...).

**MSVA today:** none — our current `outcome` enum is just `in_progress | resolved_by_va | ticket_created | human_transfer`.

**What to build:**
- Same post-call LLM pass as profile extraction, with two additional structured fields: `qualificationSignals: string[]` and `nextSteps: string[]`
- Render as pills + ordered list in the Call Details tab

**Why valuable:** turns the conversation into something actionable. The next steps drive the post-call workflow (Tier 2 item below).

---

## Tier 2 — Adopt when going to production

### 6. Per-call cost + wallet balance

**Thinkly:** header shows `Balance ₹1,47,737.18` as a wallet pill. Call history has a `CHARGED` column with the per-call cost (`₹0.00`, `₹2.90`, `₹18.00`, `₹22.80`). Hover on the wallet shows lifetime purchased, balance consumed, daily average.

**MSVA today:** none — no cost model anywhere.

**What to build:**
- Cost calculator: per-call sum of (telephony minutes × rate) + (ASR seconds × rate) + (LLM tokens × rate) + (TTS chars × rate)
- Wallet entity with purchased balance, debits, transaction log
- Header pill + hover popover
- Per-call cost column in history
- Cost dashboard page

**Why valuable:** without this the customer has no visibility into unit economics — and we have no way to flag a regression that doubles cost per call. The roadmap already lists this in cross-cutting.

### 7. Outcome tags separate from call status

**Thinkly:** distinguishes the technical status (`Completed`, `Failed`, `No Answer`, `Needs Retry`, `Retry Scheduled`) from the business outcome (`INTERESTED`, `NOT INTERESTED`). They live in separate columns.

**MSVA today:** our `outcome` enum mixes both concerns — `human_transfer` is technical, `resolved_by_va` is business.

**What to refactor:**
- Add `callStatus: "queued" | "ringing" | "in_progress" | "completed" | "no_answer" | "needs_retry" | "failed"`
- Keep `agentOutcome` as the business outcome (extracted from the conversation), separate from `callStatus`
- Update the analytics dashboard to filter on either

**Why valuable:** mixing the two hides retry logic from product analytics and blocks the retry workflow (Tier 2 item below).

### 8. Full call lifecycle + retry workflow

**Thinkly:** call history shows `Retry Scheduled`, `Needs Retry`, `No Answer`. Implies an automatic retry policy per agent — "if no answer, retry tomorrow at 6pm" kind of thing.

**MSVA today:** inbound-only, no retry concept.

**What to build:**
- Retry policy on each voice agent: max retries, backoff schedule, time-of-day windows
- A worker process that picks up "needs retry" calls and re-dials at the next eligible window
- Visible "next retry at" timestamp in the call detail drawer

**Why valuable:** required for outbound. Inbound doesn't need this, but the moment we do outbound campaigns (Phase 8) it's the difference between actually reaching customers and giving up after one ring.

### 9. LIVE / TEST toggle + date range + campaign filter

**Thinkly:** analytics has a `LIVE / TEST` toggle, a date range picker (`13-05-2026 - 19-05-2026`), and an `ALL CAMPAIGNS` filter dropdown at the top.

**MSVA today:** our analytics dashboard shows whatever's in `data/reports.csv` — no filters.

**What to build:**
- Mark every call as `live` or `test` at ingestion time
- Date range picker that hits a parameterized analytics endpoint
- Campaign filter (once campaigns exist — see Tier 3)

**Why valuable:** without the LIVE/TEST split, internal QA calls contaminate the customer-facing metrics. Without date ranges, the dashboard can only show "all time" which is useless once you've been running for more than a quarter.

### 10. Pagination + rows-per-page on call history

**Thinkly:** `Page 1 of 85`, `Rows per page: 10`, numbered pages 1–15, Prev/Next.

**MSVA today:** no call-history table at all — just demo calls.

**What to build:** straightforward. Server-paginated, with `rowsPerPage` persisted in localStorage so it's sticky.

---

## Tier 3 — Platform expansion (once the core works)

### 11. Voice Agents as first-class entities

**Thinkly:** left nav has `Voice Agents`. The call history shows the agent name per call ("Zoop agent"). Implies each agent is a configurable entity — name, system prompt, voice, language, extraction schema, performance rubric, retry policy.

**MSVA today:** one hard-coded agent in `apps/api/src/voiceAgent.ts`.

**What to build:**
- `VoiceAgent` entity (DB or YAML files)
- Each call references an agent by id
- Admin UI to create/edit agents (or YAML-in-git for v1)

**Why valuable:** the moment we have more than one intent or more than one customer, we need this. Cleanly maps to multi-tenancy too.

### 12. Bulk Campaigns

**Thinkly:** left nav has `Bulk Campaigns`. Implies CSV upload of phone numbers, a scheduled outbound campaign that dials each number with a chosen agent, with progress tracking.

**MSVA today:** none — inbound-only.

**What to build:**
- Campaign entity: name, voice agent, target list, start time, throttle (concurrent calls / minute)
- Dialer worker that pulls from the list and dials via Exotel outbound
- Per-campaign analytics rollup

**Why valuable:** required for Phase 8 outbound. Build the campaign concept first; the dialer worker is a thin shell on top.

### 13. Phone Numbers management

**Thinkly:** left nav has `Phone Numbers`. Likely lists DIDs owned, their assigned agent, monthly cost, call volume.

**MSVA today:** one DID hard-coded in env vars.

**What to build:** straightforward DID inventory page once we have more than one number.

### 14. Integrations page with CRM Webhook

**Thinkly:** `Integrations` page with cards for HubSpot, Salesforce, Teams (all `Coming Soon`) and a working `CRM Webhook` card with Active status, Configure / Disconnect buttons, "Read Developer Docs" link. Header counters: `4 Available, 1 Connected, 0 Pending`.

**MSVA today:** none — tools are wired in code (`apps/api/src/tools/crm.ts` stubs).

**What to build:**
- `CRM Webhook` first — the lowest-common-denominator integration that pushes completed-call payloads to any URL the customer configures. Configurable: URL, secret, retry policy, payload schema.
- Named connectors (HubSpot, Zoho, Freshdesk) come later as nice-to-have

**Why valuable:** CRM Webhook unlocks every customer's CRM at once without us writing N adapters. This is one of the best ideas in the Thinkly UI to copy directly.

### 15. Post-call workflow steps

**Thinkly:** the Step Breakdown tab shows a vertical list of post-call workflow nodes — `Call (Completed)`, `CRM Save (Skipped)`, `WhatsApp (Skipped)`, `Email (Skipped)`. Each has a status icon and short description.

**MSVA today:** none — actions happen inside the conversation (tool calls), not as a post-call workflow.

**What to build:**
- A small state machine that runs after every call: configurable steps per agent (CRM save → WhatsApp confirmation → email summary → calendar invite)
- Each step can succeed / fail / be skipped (with a "skipped because…" reason)
- Render the Step Breakdown tab as this state machine's visualization

**Why valuable:** separates conversational tools (need to run during the call) from operational follow-up (better as background work). Lets you add steps without changing the agent prompt.

---

## Tier 4 — Polish

### 16. Intent distribution pie chart

A pie of "this week's calls by intent" — easy once we have agent outcome extraction.

### 17. Daily call volume trend

Line chart of call count per day. We already have this for the historical CSV; need to extend it to live data once we're taking real calls.

### 18. Agent quality metrics trend

Multi-line chart of the performance scores from Tier 1 #3, plotted over time. Tells you whether the agent is getting better or worse week-over-week. Falls out for free once the judge scoring is in place.

### 19. RNR (Ring No Response) as a separate KPI

Distinct from "no answer" — we should track ringing-but-no-pickup separately from "phone off" / "call failed". Useful for outbound campaign tuning.

### 20. Sidebar collapse toggle

Cosmetic but nice for power users on smaller screens.

### 21. Lead Source tag per call

`Lead Source: API` is visible in the Thinkly drawer header. We should tag every call with how it was triggered — `inbound`, `bulk_campaign`, `api`, `manual`, `retry` — so analytics can slice by source.

---

## What we deliberately don't copy

Some things in the Thinkly UI fit Thinkly's domain (D2C seller onboarding) but not ours:

- **Seller-platform fields** (HAS_FACEBOOK, FACEBOOK_FOLLOWERS, PLATFORMS_RAW). The pattern (per-agent extraction schema) is great; the specific fields are theirs. Ours would be order numbers, batch numbers, distributor codes, delivery routes.
- **CROSS_SELL as a perf metric**. Useful for sales agents, not for a complaint/support agent. We'd swap it for something like `RESOLUTION_QUALITY` or `EMPATHY`.
- **Bulk Campaigns workflow assumes outbound**. We'll need it eventually, but not for Phase 1–4.

---

## What gets ported into the roadmap

Items 1–5 (call drawer, profile extraction, performance scoring, recording + transcript, qualification signals) → new **Phase 3.5 — Call Inspector** in [calling-roadmap.md](./calling-roadmap.md).

Items 6–10 (cost/wallet, status/outcome split, retry workflow, dashboard filters, pagination) → extensions to **Phase 3 — Production reliability** and **Phase 5 — Dashboard / QA / recording**.

Items 11–15 (voice agents entity, campaigns, phone numbers, CRM webhook, post-call workflow) → new **Phase 6.5 — Platform expansion**.

Items 16–21 (charts, RNR, sidebar, lead source) → distributed across **Phase 5 — Dashboard** items.
