# Madhusudan Call-journey Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a credible Madhusudan demo that handles consumer, retailer,
distributor, and prospect conversations while accurately separating durable
MSVA actions from fixture data and unconnected business systems.

**Architecture:** Retain React/TypeScript in `apps/web`, Node/Express in
`apps/api`, and PostgreSQL/Prisma in `packages/db`. The approved foundation
adds canonical contracts and durable request persistence only. A later,
separately gated phase may add a Python 3.12 LiveKit-Agents service, self-hosted
LiveKit media/SIP, and authenticated call-scoped Node APIs. No LiveKit audio,
telephone path, or deployed demo exists in the foundation. Voice cloning is a
later, separately authorised evaluation.

**Tech Stack:** React 19, Vite, TypeScript, Node/Express, Zod, PostgreSQL,
Prisma, Python 3.12, LiveKit Agents, self-hosted LiveKit/SIP/Redis, Sarvam STT
and TTS, the approved LLM provider.

**Spec:** `docs/demo/demo-scope.md`

## Global constraints

- Retain the React, Node, and Prisma application; do not run the old raw-PCM
  and LiveKit conversation controllers for the same call.
- Use Python LiveKit Agents with self-hosted media and SIP; validate Exotel and
  Sarvam account prerequisites before representing telephone calling as live.
- Browser and telephone callers use the same business contracts; browser calls
  have `isTest=true` and remain distinguishable in all reporting.
- LiveKit room names, carrier SIDs, and provider webhooks are transport
  metadata; the application `callId` is the durable business identity.
- The worker does not get direct database access or unrestricted CRM queries.
  It uses versioned, authenticated, call-scoped Node APIs.
- A recorded ticket, callback request, handoff request, lead, or photo request
  is not a completed callback, human connection, order, refund, message, or
  received attachment.
- Unknown integrations return `UNAVAILABLE`; fixture sources return `FIXTURE`.
  The UI and speech must not turn either result into a business promise.
- An authenticated attachment is `RECEIVED` only after object storage and
  metadata both succeed. No connected attachment service means `REQUESTED` or
  `UNAVAILABLE`, never a received photo.
- Handoff uses the same room. AI output and mutating tools stop before the
  assigned human may publish audio; no two humans may own the same call.
- Separate sentiment from urgency. Start urgency/SOS detection in shadow mode
  with a staffed fallback; do not claim diagnosis or automatic emergency
  assistance.
- Do not add voice cloning to this demo phase. Evaluate it later using only
  approved reference material, with standard voice as fallback.
- Do not place real inbound/outbound test calls, use private account data, or
  enable phone routing without the named owner’s approval and the relevant
  acceptance gate.

## Review focus

1. A returning caller with the same phone but a different issue sees no prior
   complaint details before verified identity and context confirmation; covered
   in DEMO-COMPLAINT.
2. A tool timeout after writing a ticket does not create a second ticket on
   retry; covered in DEMO-COMPLAINT.
3. A photo-request screen never marks a `FIXTURE`, failed upload, or pending
   external request as `RECEIVED`; covered in DEMO-EVIDENCE.
4. Two staff users trying to take the same call leave one owner, one active
   microphone, and an accurate pending/failure record; covered in
   DEMO-HANDOFF.
5. A neutral-sounding possible product-safety report gets an urgency alert,
   while an angry delivery complaint remains ordinary priority support;
   covered in DEMO-RISK.

---

## Proposed file map

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/demo.ts` | Versioned Zod source schemas for call context, request actions, evidence, handoff, risk, and API fixtures. |
| `packages/contracts/src/export-demo-contracts.ts` | Deterministic exporter for canonical JSON Schema and OpenAPI artifacts. |
| `packages/contracts/openapi/demo-v1.json` | Checked-in canonical OpenAPI 3.1 contract for Node-worker and staff API routes. |
| `packages/contracts/json-schema/demo-v1/*.json` | Checked-in JSON Schema 2020-12 artifacts that Python validates before using a payload. |
| `packages/contracts/fixtures/demo-journeys/*.json` | Contract fixtures for each caller journey and expected truth labels. |
| `packages/db/prisma/schema.prisma` | Additive durable entities and fields for requests, callback state, evidence, queues, handoff, and risk. |
| `packages/db/prisma/migrations/<generated>_demo_journeys/migration.sql` | Additive migration preserving existing calls and tickets. |
| `apps/api/src/demo/{admissions,context,requests,evidence,queues,risk}.ts` | Staff-simulation policy and later call-scoped business wrappers. |
| `apps/api/src/demo/routes.ts` | Future authenticated staff simulation routes mounted by `apps/api/src/server.ts`. |
| `apps/api/src/voice/{sessions,tokens,handoff,admission}.ts` | Browser LiveKit session creation, staff admission, and ownership control. |
| `apps/api/src/call-events/routes.ts` | Authenticated, idempotent event ingestion from the worker and LiveKit. |
| `apps/voice-agent/` | Python 3.12 worker, prompt/policy, tool client, event spool, canonical-schema validation, and tests. |
| `apps/web/src/demo/` | Later truth-labelled journey components; not the complaint workflow entry. |
| `apps/web/src/console/call-desk/` | Staff-authenticated complaint simulation, private context, evidence state, risk alert, and same-room handoff UI. |
| `deploy/livekit/` | Pinned self-hosted LiveKit, SIP, Redis, health checks, and environment templates. |
| `apps/api/src/voice/outbound.ts` | Durable, optional callback and sales-follow-up job policy after controlled phone validation. |
| `docs/demo/run-sheet.md` | Operator checklist, dialogue, truth labels, fallback, and evidence capture. |

Existing `apps/api/src/calls.ts`, `apps/api/src/tools/crm.ts`,
`apps/api/src/tools/transfer.ts`, `apps/api/src/voiceAgent.ts`,
`apps/web/src/App.tsx`, and `apps/web/src/callClient.ts` remain migration
inputs. Preserve the legacy route until browser LiveKit acceptance is met.

This is a proposed file map for later phases, not a statement that these
routes, worker services, audio paths, or deployments exist. The implemented
foundation is limited to the canonical contract package, deterministic
artifacts, additive database migration, and unmounted transaction primitive.

## Interfaces

The canonical public source is `packages/contracts/src/demo.ts`; it exports
the schema/type pairs named there and generates the checked-in OpenAPI 3.1 and
JSON Schema 2020-12 artifacts. Do not maintain illustrative duplicate wire
types in this plan. The request input is a strict journey-specific structural
union: `FOLLOW_UP` requires `parentRequestId`, while `NEW` and `SEPARATE`
forbid it. Server-owned identity, fixture, ticket, source, storage, queue-owner
and trust fields are not request input.

The successful immutable creation receipt has `truthState: "RECORDED"`,
`actionState: "PENDING_STAFF"`, and `evidenceState: "NOT_REQUESTED"`.
`PENDING_STAFF` is work state, not a truth state. Source provenance is carried
by the canonical source/evidence contracts: `CONNECTED` requires a server
source reference, `FIXTURE` is explicitly labelled, and `UNAVAILABLE` is not
a successful business action. Fixtures demonstrate values but do not define
the contract.

The following worker and staff routes are future planned surfaces, not mounted
foundation endpoints. When implemented, worker mutations require a service
credential and fenced call lease; staff routes require authenticated console
access:

```text
POST /api/admin/demo/calls/:callId/handoff
  -> { handoffId, state: "REQUESTED", version }
POST /api/admin/demo/calls/:callId/takeover
  body: { handoffId, expectedVersion }
  -> { state, version, participantIdentity }
POST /api/admin/demo/tickets/:ticketId/evidence-request
  -> { ticketId, evidenceState: "REQUESTED", truthState: "RECORDED" }
POST /api/admin/demo/tickets/:ticketId/evidence
  multipart file + metadata
  -> { evidenceId, evidenceState: "RECEIVED" }
POST /api/admin/voice/outbound
  body: { requestId, contactId, purpose: "CALLBACK" | "SALES_FOLLOW_UP", scheduledAt }
  -> { jobId, callId, state: "SCHEDULED" }
```

The evidence-upload route,
`POST /api/admin/demo/tickets/:ticketId/evidence`, is disabled with a clear
`UNAVAILABLE` result until attachment storage and access policy exist. No
browser receives a LiveKit service secret.
For real calls, the context route returns no `priorRequests` until the backend
records `identityAssurance: "VERIFIED"`; it returns specific summaries only
after the caller also confirms the matter is relevant. `DEMO_TRUSTED` is a
backend-only fixture identity for an authenticated `isTest=true` browser
session, never a carrier identity or client-supplied flag. The outbound route
resolves the approved destination from `contactId` server-side; a callback
request remains separate from a scheduled or completed dial.

## Delivery roles

| Role | Owns | Review boundary |
| --- | --- | --- |
| Product/integration lead | truth labels, journey scripts, business decisions, acceptance evidence | confirms no demo statement exceeds a connected capability |
| Data and API engineer | Prisma migration, contracts, idempotency, queues, ticket/lead/callback persistence | reviews retry and caller-verification cases |
| Voice engineer | LiveKit deployment, Python worker, Sarvam/model integration, worker events | reviews audio failure and recovery evidence |
| Web/call-desk engineer | browser caller experience, staff queue, private summary, evidence states, takeover controls | reviews accessibility and operator failure states |
| QA/operator | fixtures, journey execution, carrier validation, fault tests, run sheet | signs off each acceptance gate with retained test evidence |

## Phase checkpoints

| Code | Deliverable | Gate before proceeding |
| --- | --- | --- |
| DEMO-FOUNDATION | Contract and database truth model | canonical JSON Schema/OpenAPI artifacts and fixtures validate in TypeScript and Python; existing ticket tests still pass |
| DEMO-COMPLAINT | Staff-authenticated complaint workflow simulation | owner-scoped synthetic admissions, confirmed-context follow-up, and simulation isolation are durable |
| DEMO-VOICE | Browser LiveKit conversation | two-way audio, final transcript, and worker events persist across a controlled restart |
| DEMO-HANDOFF | Territory/language queue and same-room takeover | operator ownership race, denied microphone, and no-operator timeout are accurate |
| DEMO-JOURNEYS | Retailer, distributor, and prospect cards | each shows a correct truth label and no unconnected action is claimed |
| DEMO-RISK | Shadow urgency and staffed fallback | labelled fixtures cover Hindi/English/Hinglish and review results are recorded |
| DEMO-PHONE | Exotel/SIP phone demonstration | real controlled calls meet carrier, media, transcript, and handoff acceptance |
| DEMO-OUTBOUND | Optional controlled callback and sales follow-up | one eligible contact receives at most one reconciled attempt; answer/no-answer outcomes are evidenced |

## Board mapping

The parent delivery board can map these stable phase codes to its own tracker
identifiers without rewriting the implementation plan.

```csv
phase,summary,depends_on,completion_gate
DEMO-FOUNDATION,Truth-labelled contracts and additive persistence,,Canonical JSON Schema OpenAPI and fixtures validate; legacy ticket tests pass
DEMO-COMPLAINT,Staff-authenticated complaint workflow simulation,DEMO-FOUNDATION,Owner-scoped simulation and confirmed-context follow-up are durable
DEMO-EVIDENCE,Photo-request and attachment truth states,DEMO-COMPLAINT,Fixture or failed upload cannot appear received
DEMO-VOICE,Browser LiveKit complaint conversation,DEMO-COMPLAINT,Final transcript and one idempotent request persist
DEMO-HANDOFF,Territory-language queue and same-room takeover,DEMO-VOICE,One operator owns a usable microphone after AI silence
DEMO-JOURNEYS,Retailer distributor and prospect cards,DEMO-FOUNDATION;DEMO-HANDOFF,All result labels and next actions are truthful
DEMO-RISK,Shadow urgency and staffed fallback,DEMO-HANDOFF,Reviewed language fixtures and fallback outcomes exist
DEMO-PHONE,Exotel SIP controlled phone evidence,DEMO-VOICE;DEMO-HANDOFF,Carrier room transcript action and fallback records reconcile
DEMO-OUTBOUND,Optional callback and sales follow-up,DEMO-PHONE;DEMO-JOURNEYS,Eligible contact outcomes reconcile without duplicate dialing
```

## Tasks

### DEMO-FOUNDATION: Define truth-labelled durable contracts

**Files:**

- Create: `packages/contracts/src/demo.ts`
- Create: `packages/contracts/src/export-demo-contracts.ts`
- Create: `packages/contracts/openapi/demo-v1.json`
- Create: `packages/contracts/json-schema/demo-v1/caller-context.json`
- Create: `packages/contracts/json-schema/demo-v1/create-request.json`
- Create: `packages/contracts/json-schema/demo-v1/handoff.json`
- Create: `packages/contracts/json-schema/demo-v1/risk-assessment.json`
- Create: `packages/contracts/fixtures/demo-journeys/consumer-returning.json`
- Create: `packages/contracts/fixtures/demo-journeys/retailer-enquiry.json`
- Create: `packages/contracts/fixtures/demo-journeys/distributor-account.json`
- Create: `packages/contracts/fixtures/demo-journeys/sales-prospect.json`
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260921000000_demo_journeys/migration.sql`
- Create: `packages/contracts/src/demo.test.ts`
- Create: `packages/contracts/src/export-demo-contracts.test.ts`
- Create: `packages/db/src/demoJourneys.integration.test.ts`
- Create: `packages/db/src/demoRequests.ts`
- Create: `packages/db/src/demoRequests.integration.test.ts`
- Create: `apps/voice-agent/pyproject.toml`
- Create: `apps/voice-agent/uv.lock`
- Create: `apps/voice-agent/tests/test_contract_schema.py`

**Consumes:** Existing `Caller`, `Call`, `Ticket`, `TicketNote`, `User`, and
`AuditLog` models.

**Produces:** Canonical JSON Schema/OpenAPI artifacts, validated contracts, and additive records: `BusinessRequest`,
`EvidenceAttachment`, `QueueAssignment`, `CallbackRequest`, `Handoff`,
`RiskAssessment`, and `RiskAlert`. `BusinessRequest` includes `journey`,
`truthState`, `parentRequestId`, `language`, `territory`, `verificationState`,
and idempotent `requestId`. `CallbackRequest` has a request state separate
from carrier attempts.

**Implemented foundation status:** The reviewed foundation now provides the
canonical contracts/artifacts, additive migration, and unmounted request
transaction primitive with PostgreSQL evidence. This plan keeps its original
unchecked task list as implementation-plan history; it does not imply that the
later complaint, worker, browser audio, phone, handoff, or deployment phases
are implemented.

- [ ] Write contract tests that reject an unknown truth state, `RECEIVED`
  evidence without `storageKey`, a distributor account case without a
  verification state, and a `CONNECTED` result without `sourceRef`.
- [ ] Run the contract tests and verify each invalid fixture fails at schema
  parsing.
- [ ] Add the Zod schemas, derived types, and four valid JSON fixtures. Make
  the seeded-order fixture carry `truthState: "FIXTURE"`.
- [ ] Implement `export-demo-contracts.ts` so it emits OpenAPI 3.1 and JSON
  Schema 2020-12 from the Zod source with stable ordering. Add a test that
  regenerates the artifacts and fails on a checked-in diff. Add a Python
  contract test at `apps/voice-agent/tests/test_contract_schema.py` that loads
  the canonical JSON Schema artifacts and rejects an invalid worker payload.
- [ ] Create the minimal Python 3.12 `pyproject.toml` and lockfile needed only
  for canonical-schema validation and its test runner. Do not add media,
  telephony, speech, or model-provider dependencies in this foundation slice.
- [ ] Add only backward-compatible Prisma tables/columns and foreign keys;
  preserve `Call`, `Ticket`, and historical ticket numbers. Use a unique
  `BusinessRequest.requestId` for idempotency and store a caller-confirmation
  value before linking a prior request.
- [ ] Write database tests for a retry with the same request ID, a retry with
  different arguments, separate follow-up versus separate-case creation, and
  a callback request that is not an outbound attempt. Apply the generated
  migration to representative existing `Call`, `Ticket`, and `TicketNote`
  records, then assert their IDs, counts, outcomes, numbers, and timestamps
  are unchanged and the new foreign keys/defaults are valid.
- [ ] Run the TypeScript contract/export tests, Python canonical-schema test,
  focused database tests, and existing call/ticket tests. Expected result: no
  duplicate business request, no contract-artifact drift, and no changed
  legacy call outcome. Record the representative-migration integrity result in
  the task evidence.
- [ ] Commit this independently reviewable slice with a focused message.

**Acceptance:** The system can represent all four journeys without treating a
fixture or pending staff action as a connected business outcome, and Python
validates the checked-in canonical JSON Schema rather than inferring a contract
from fixtures. The migration has demonstrated no historical change to
representative calls, tickets, or notes.

### DEMO-COMPLAINT: Build the new and returning consumer complaint slice

**Approved architecture decision; not yet implemented:** This phase is an
authenticated console workflow simulation, not a public caller page or an
audio/telephone demo. It uses owner-scoped synthetic admissions and terminal
simulation records. Those records are excluded from live-call, ticket, SLA,
turn, and active-call metrics; they remain available only through authorised
simulation receipt/detail access. No prior history or caller identity is
returned before the user explicitly confirms the relevant matter. A future
HTTP wrapper must authorise the admission, identity, and frozen parent inside
the foundation transaction before replay or recovery, rather than treating a
previous context read as authority.

**Files:**

- Create: `apps/api/src/demo/admissions.ts`
- Create: `apps/api/src/demo/context.ts`
- Create: `apps/api/src/demo/requests.ts`
- Create: `apps/api/src/demo/routes.ts`
- Create: `apps/api/src/demo/context.test.ts`
- Create: `apps/api/src/demo/requests.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: the authenticated console route/navigation and its call, ticket, and
  polling metric views
- Modify: `packages/db/prisma/schema.prisma` and add an admission migration
- Create: a console-only complaint workflow component and focused tests

**Consumes:** `CallerContext`, `CreateRequestInput`, the additive data model,
and existing ticket persistence.

**Produces:** A staff-authenticated console workflow simulation for new,
returning, confirmed-follow-up, separate-complaint, and unverified paths. It
uses the foundation `createBusinessRequest` primitive rather than introducing
another persistence path.

- [ ] Write API tests for a new caller, a real returning caller before
  verification, a verified caller before context confirmation, a confirmed
  follow-up, a different complaint, a backend-issued `DEMO_TRUSTED` browser
  fixture, an attempted client-supplied demo flag, and a request retry after a
  simulated response loss.
- [ ] Run the tests and verify real unverified callers receive no prior case,
  order, invoice, or account details; verified callers still receive no
  specific summary before context confirmation; duplicate retries return the
  original request result.
- [ ] Implement context from a trusted server-resolved admission, Call, and
  identity; do not accept caller-supplied assurance, parent IDs, fixture keys,
  ownership, or test flags. Return no history before relevant confirmation.
  For FOLLOW_UP, the wrapper supplies its owner-scoped frozen parent.
- [ ] Authorise admission, identity, and parent scope inside the foundation
  transaction before either replay/recovery or creation. Reuse the canonical
  idempotent primitive; do not wrap it in an independently transacting write
  path or silently route legacy ticket tools through it.
- [ ] Create terminal synthetic records only through staff-authenticated,
  owner-scoped admission. Keep their simulation classification immutable and
  exclude them from live call, ticket, SLA, turn, and active polling metrics.
- [ ] Build the journey component with required complaint fields: product,
  batch/expiry when available, purchase area, issue category, description,
  product availability, language, and territory. Render the returned truth
  state beside the spoken confirmation.
- [ ] Run API and browser-component tests. Add an accessibility assertion for
  visible status text rather than colour-only state.
- [ ] Commit this independently reviewable slice with a focused message.

**Acceptance:** An authorised staff member can run the clearly labelled
workflow simulation and use a `DEMO_TRUSTED` fixture to demonstrate a
returning follow-up. No audio, telephone, carrier, or deployed-demo claim is
made. Real callers require verified identity and relevant-context confirmation
before any prior case/order detail is exposed.

### DEMO-EVIDENCE: Add honest product-photo request and attachment handling

**Files:**

- Create: `apps/api/src/demo/evidence.ts`
- Create: `apps/api/src/demo/evidence.test.ts`
- Modify: `apps/api/src/demo/routes.ts`
- Create: `apps/web/src/console/call-desk/EvidencePanel.tsx`
- Create: `apps/web/src/console/call-desk/EvidencePanel.test.tsx`
- Create: `apps/api/src/storage/attachments.ts`
- Create: `apps/api/src/storage/attachments.test.ts`

**Consumes:** Consumer complaint ticket/request and `EvidenceState` contract.

**Produces:** `requestEvidence(ticketId)` and, only when a configured private
attachment adapter is enabled, `storeEvidence(ticketId, file, metadata)`.

- [ ] Write tests for each transition: `NOT_REQUESTED → REQUESTED`, configured
  upload → `RECEIVED`, missing adapter → `UNAVAILABLE`, rejected MIME/size,
  failed object write, failed metadata write, retry, and fixture image.
- [ ] Run the tests and verify no failed or fixture path produces
  `EvidenceState.RECEIVED`.
- [ ] Implement an attachment adapter interface:

  ```ts
  type AttachmentStore = {
    put(input: { ticketId: string; bytes: Uint8Array; contentType: string }): Promise<{ storageKey: string }>;
    remove(storageKey: string): Promise<void>;
  };
  ```

  Keep its implementation disabled until approved private storage, retention,
  and staff-access configuration are present. On a metadata-write failure,
  remove the object when supported and return `UNAVAILABLE` rather than
  inventing a received state.
- [ ] Implement the evidence-request route and call-desk panel. The panel
  displays `FIXTURE`, `REQUESTED`, `RECEIVED`, or `UNAVAILABLE` as text and
  states the next staff action. It contains no WhatsApp-sent language.
- [ ] Run API and component tests; manually verify the staff view can
  distinguish a sample image from a stored attachment.
- [ ] Commit this independently reviewable slice with a focused message.

**Acceptance:** The demo can show structured photo evidence without claiming
an external channel or a received file that has not been verified.

### DEMO-VOICE: Establish the browser LiveKit vertical slice

**Files:**

- Create: `deploy/livekit/`
- Modify: `apps/voice-agent/pyproject.toml`
- Modify: `apps/voice-agent/uv.lock`
- Create: `apps/voice-agent/src/madhusudan_voice/{agent,policy,tools,events}.py`
- Create: `apps/voice-agent/tests/{test_policy,test_tools,test_events}.py`
- Create: `apps/api/src/voice/{sessions,tokens,admission}.ts`
- Create: `apps/api/src/voice/sessions.test.ts`
- Create: `apps/api/src/call-events/routes.ts`
- Create: `apps/api/src/call-events/routes.test.ts`
- Create: `apps/web/src/livekit/BrowserCall.tsx`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/web/src/callClient.ts`

**Consumes:** Demo contracts, worker context/request routes, and a configured
standard voice.

**Produces:** A test-marked browser session in one room, final transcript and
request events, and a worker that uses Node tool APIs rather than direct DB
access.

- [ ] Confirm the selected self-hosted LiveKit, SIP, Redis, Sarvam, and LLM
  versions are mutually compatible. Record only public configuration names in
  templates; keep credentials server-side.
- [ ] Write tests for a denied session, wrong-room token, expired/used
  admission, `isTest=true` browser session, tool request schema rejection,
  duplicate worker event, and worker event replay after API recovery.
- [ ] Run the tests and confirm browsers cannot receive a service credential
  or join an unauthorised room.
- [ ] Implement a short-lived session/token route. The server chooses
  `callId`, room, participant identity, and grants. Authenticate the worker
  to the internal context/request/event routes; include the current call lease
  in every mutating request.
- [ ] Implement the Python worker with one turn-ending authority, explicit
  Hindi/English/Hinglish configuration, final/interim transcript separation,
  an authenticated tool client, and a bounded disk-backed event spool. The
  policy converts every tool result into truthful wording from `TruthState`.
- [ ] Implement browser audio tracks for the new route while preserving the
  legacy raw-PCM route until migration acceptance. Handle microphone denial,
  reconnect, caller hangup, and provider failure as visible states.
- [ ] Run Python unit tests, Node tests, web tests, and a controlled manual
  browser conversation. Restart the worker during a temporary API outage and
  verify replay does not create a duplicate request.
- [ ] Commit this independently reviewable slice with a focused message.

**Acceptance:** A real browser conversation creates the complaint record and
final transcript through the Python worker; a browser or test fixture alone
is never presented as a telephone call.

### DEMO-HANDOFF: Route by territory/language and take over in the same room

**Files:**

- Create: `apps/api/src/demo/queues.ts`
- Create: `apps/api/src/demo/queues.test.ts`
- Create: `apps/api/src/voice/handoff.ts`
- Create: `apps/api/src/voice/handoff.test.ts`
- Modify: `apps/api/src/tools/transfer.ts`
- Modify: `apps/api/src/demo/routes.ts`
- Create: `apps/web/src/console/call-desk/QueuePanel.tsx`
- Create: `apps/web/src/console/call-desk/HandoffPanel.tsx`
- Create: `apps/web/src/console/call-desk/HandoffPanel.test.tsx`
- Modify: `apps/voice-agent/src/madhusudan_voice/policy.py`

**Consumes:** Browser voice session, authenticated staff admission, `QueueAssignment`,
and `Handoff` records.

**Produces:** `requestHandoff(callId, reason)` and
`takeover(handoffId, expectedVersion)` with compare-and-set ownership and
truthful `PENDING_STAFF`, `HUMAN_ACTIVE`, `FAILED`, or `TIMED_OUT` state.

- [ ] Write queue tests for known territory/language, unsupported language,
  missing territory, and no eligible operator. Write handoff tests for two
  simultaneous accept attempts, microphone denial, AI stop timeout, operator
  disconnect, caller departure, and stale version.
- [ ] Run the tests and verify only one handoff request becomes assigned; the
  other is a conflict rather than a second active owner.
- [ ] Implement queue selection from an approved configuration map with a
  visible default support queue. Do not infer territory from accent or model
  output.
- [ ] Implement handoff state changes: `REQUESTED → ASSIGNED → JOINING →
  HUMAN_ACTIVE`. Before `HUMAN_ACTIVE`, cancel AI speech, block new mutating
  tool requests, wait for acknowledgement, grant only the assigned operator
  audio publication, and verify a live track. Persist `FAILED` or `TIMED_OUT`
  with its reason when this cannot happen.
- [ ] Show a private, authorised staff summary; do not put account context in
  room-wide metadata. Keep caller-only transcription/risk observation active
  without treating human speech as caller evidence.
- [ ] Run focused tests and a two-browser manual exercise. Capture an operator
  acceptance, a simultaneous conflict, and an unavailable-operator fallback.
- [ ] Commit this independently reviewable slice with a focused message.

**Acceptance:** A qualified staff user can speak to the caller in the original
room only after the AI is silent and the participant track is usable; a saved
ticket alone never displays as a completed handoff.

### DEMO-JOURNEYS: Add retailer, distributor, and sales-prospect cards

**Files:**

- Create: `apps/api/src/demo/journeys.ts`
- Create: `apps/api/src/demo/journeys.test.ts`
- Create: `apps/web/src/demo/RetailerJourney.tsx`
- Create: `apps/web/src/demo/DistributorJourney.tsx`
- Create: `apps/web/src/demo/SalesProspectJourney.tsx`
- Create: `apps/web/src/demo/JourneyTruthCard.tsx`
- Create: `apps/web/src/demo/JourneyTruthCard.test.tsx`
- Modify: `apps/api/src/tools/crm.ts`
- Modify: `apps/web/src/App.tsx`
- Create: `docs/demo/run-sheet.md`

**Consumes:** Foundation contracts, caller context, request persistence, queue
selection, and handoff state.

**Produces:** Four journey controls and scripts that share a truthful request
contract; retailer enquiries, distributor cases, and sales leads preserve
their distinct fields and permissions.

- [ ] Write API tests for retailer follow-up versus new request, distributor
  account request with and without verification, fixture order result,
  unavailable inventory, new prospect lead, and duplicate callback request.
- [ ] Run the tests and verify `FIXTURE` and `UNAVAILABLE` appear in both
  structured results and agent text.
- [ ] Implement per-journey field validation. Retailer requires shop/contact,
  product/quantity, territory, and callback preference. Distributor requires
  enquiry type and verification state before an account result. Prospect
  requires organisation, buyer role, territory, product interest, and contact
  preference.
- [ ] Keep the current seeded-order reader behind a `FIXTURE` adapter. Return
  `UNAVAILABLE` for inventory and live account data until an authorised source
  adapter is completed. Never make `createBusinessRequest` place an order.
- [ ] Build the three journey components and shared truth card. Each shows the
  request ID, assigned queue, source state, and exact next action. Use
  `PENDING_STAFF` for a recorded callback preference until an outbound attempt
  has a reconciled outcome.
- [ ] Write the operator run sheet with preflight, dialogue, expected UI
  labels, a fallback when voice/media is unavailable, and what evidence to
  retain after each journey.
- [ ] Run all journey tests and perform one controlled browser script per
  journey. Verify no script says an order was placed, stock was confirmed,
  money was refunded, WhatsApp was sent, or a callback happened without
  evidence.
- [ ] Commit this independently reviewable slice with a focused message.

**Acceptance:** All four journeys are visibly distinct, repeat-caller aware,
and factually bounded by their real integration state.

### DEMO-RISK: Observe urgency separately from sentiment with a staffed fallback

**Files:**

- Create: `apps/voice-agent/src/madhusudan_voice/risk.py`
- Create: `apps/voice-agent/tests/test_risk.py`
- Create: `apps/api/src/demo/risk.ts`
- Create: `apps/api/src/demo/risk.test.ts`
- Create: `apps/web/src/console/call-desk/RiskAlert.tsx`
- Create: `apps/web/src/console/call-desk/RiskAlert.test.tsx`
- Create: `packages/contracts/fixtures/risk/*.json`
- Create: `docs/demo/risk-evaluation.md`

**Consumes:** Final caller transcript segments, handoff workflow, queue rules,
and staffed-owner decisions.

**Produces:** A labelled scripted-demo alert path, independent sentiment and
urgency assessments, durable alerts, and a reviewed production shadow-mode
scorecard.

- [ ] Obtain the business decision recorded in the scope document: SOS
  definition, staffed hours, primary/fallback owner, and approved copy. Do
  not enable live routing while any is absent.
- [ ] Write labelled fixtures for Hindi, English, and Hinglish: calm possible
  adverse-product event, angry routine delivery complaint, direct human
  request, negation, quoted history, third-party report, background speech,
  and low-quality transcript.
- [ ] Write tests that require a labelled scripted neutral possible-safety
  report to open the demo alert UI, require an angry routine complaint not to
  create a safety alert, and reject an assessment that names a nonexistent
  transcript segment.
- [ ] Implement a deterministic unambiguous-request rule plus a structured
  contextual classifier. Record `sentiment`, `urgency`, evidence segment IDs,
  detector version, and `provisional` state separately. A human request bypasses
  sentiment scoring.
- [ ] Deduplicate repeated evidence into the active alert. Preserve no-staff,
  timeout, disconnect, acknowledgement, and resolution outcomes. A later
  cheerful sentence cannot clear an active safety alert automatically.
- [ ] Keep the controlled scripted alert demonstration visibly labelled as a
  fixture/workflow test. For production calls, run the detector in shadow mode
  with normal staffed support: do not automatically reroute, interrupt, or
  make emergency claims from detector output until the business policy and
  validation gate are passed. Record misses, false alerts per 100 routine
  calls, alert delay, and handoff success separately by language/audio
  condition in `docs/demo/risk-evaluation.md`.
- [ ] Commit this independently reviewable slice with a focused message.

**Acceptance:** The controlled scripted demo presents urgency as a labelled
staff-assistance workflow with real fallback states. Production remains
shadow-only until the staffed policy and reviewed evaluation gate are complete;
neither mode is a clinical or emergency-service promise.

### DEMO-PHONE: Validate Exotel/SIP only after the browser demo is stable

**Files:**

- Modify: `deploy/livekit/`
- Modify: `apps/api/src/call-events/routes.ts`
- Create: `apps/api/src/call-events/reconcile.ts`
- Create: `apps/api/src/call-events/reconcile.test.ts`
- Modify: `docs/exotel-inbound.md`
- Create: `docs/demo/phone-validation.md`

**Consumes:** Proven browser worker, handoff, queues, and account approval for
carrier/Sarvam testing.

**Produces:** Linked carrier/SIP/room/application call records and an evidence
based acceptance report.

- [ ] Verify current Exotel account capability, inbound trunk parameters,
  callback authentication, Sarvam realtime access, and the staffed carrier
  fallback. Record missing prerequisites as blockers rather than guessed
  configuration.
- [ ] Write reconciliation tests for duplicate carrier events, carrier attempt
  with no room, room with missing carrier completion, caller disconnect before
  worker dispatch, no-worker capacity, and late end event after a recorded
  ticket.
- [ ] Configure the approved test route with trust boundaries and an explicit
  worker dispatch rule. Preserve carrier raw reason codes alongside normalized
  application state.
- [ ] Conduct authorised controlled test calls from two independent mobile
  networks. Exercise answer, two-way audio, interruption, transcript, ticket
  creation, human takeover, no-worker, and fallback behaviour.
- [ ] Reconcile carrier events with LiveKit and API records. Do not infer a
  successful answer or transfer from a single dashboard record.
- [ ] Record every observed result, defect, fallback outcome, and unresolved
  prerequisite in `docs/demo/phone-validation.md`. Keep browser test records
  separate from phone evidence.
- [ ] Commit this independently reviewable slice with a focused message.

**Acceptance:** The telephone demo is enabled only after a controlled call
shows a carrier record, room/participant record, final transcript, durable
business action, and accurate handoff/fallback outcome.

### DEMO-OUTBOUND: Add optional callback and sales-follow-up calling after phone validation

**Files:**

- Create: `apps/api/src/voice/outbound.ts`
- Create: `apps/api/src/voice/outbound.test.ts`
- Create: `apps/api/src/voice/outboundWorker.ts`
- Create: `apps/api/src/voice/outboundWorker.test.ts`
- Modify: `packages/db/prisma/schema.prisma`
- Modify: `packages/contracts/src/demo.ts`
- Modify: `packages/contracts/openapi/demo-v1.json`
- Create: `packages/contracts/json-schema/demo-v1/outbound-job.json`
- Modify: `apps/api/src/call-events/reconcile.ts`
- Modify: `apps/web/src/console/call-desk/QueuePanel.tsx`
- Create: `docs/demo/outbound-validation.md`

**Consumes:** Controlled-phone acceptance, an approved carrier outbound path,
durable callback requests, sales leads, contact eligibility, opt-out policy,
and the approved contact-window rule.

**Produces:** Optional staff-triggered `CALLBACK` and `SALES_FOLLOW_UP` jobs.
`POST /api/admin/voice/outbound` accepts a unique `requestId`, a server-resolved
`contactId`, `purpose`, and `scheduledAt`; it returns a durable job and
application call identity before any dial. It does not accept an arbitrary
phone number from the browser.

- [ ] Write tests for ineligible contact, opt-out, invalid contact window,
  duplicate request ID, concurrent scheduler claim, cancellation before dial,
  opt-out after scheduling, provider timeout after possible acceptance,
  answer, no-answer, busy, and carrier reconciliation after restart.
- [ ] Run the tests and verify a callback request alone creates no carrier
  attempt; a duplicate request never creates a second logical job; and an
  uncertain provider response is reconciled before retrying.
- [ ] Add `OutboundJob` and `OutboundAttempt` additively. Store eligibility
  decision, opt-out snapshot, contact-window evaluation, lease/claim state,
  carrier result, and answer/no-answer/busy/rejected/cancelled outcome
  separately from `CallbackRequest` and `BusinessRequest`.
- [ ] Implement scheduling policy at creation and immediately before dial. The
  worker atomically claims one job, creates the application call/room, calls
  the approved carrier adapter once, and speaks only after the remote party is
  connected. Retries use bounded backoff and a reconciled previous result;
  stopping a campaign prevents future jobs without dropping an active call.
- [ ] Extend canonical OpenAPI/JSON Schema and Python/Node contract tests for
  `OutboundJob`. The call desk shows `REQUESTED`, `SCHEDULED`, `DIALING`, and
  final attempt outcomes distinctly, and labels the feature unavailable until
  the outbound gate is enabled.
- [ ] Run authorised controlled outbound calls only after the policy owner
  explicitly enables the gate. Test an opted-in callback and an opted-in sales
  follow-up, then reconcile carrier, room, transcript, request, and attempt
  evidence in `docs/demo/outbound-validation.md`.
- [ ] Commit this independently reviewable slice with a focused message.

**Acceptance:** An eligible, opted-in contact receives at most one intended
callback or sales-follow-up attempt for one request ID. The demo distinguishes
a requested callback, a scheduled/dialing job, and verified answer/no-answer
carrier outcomes; no real outbound call occurs before explicit approval.

## Completion checklist

- [ ] DEMO-FOUNDATION through DEMO-JOURNEYS pass their focused tests and
  manual browser scripts.
- [ ] The run sheet labels provenance/truth as `RECORDED`, `CONNECTED`,
  `FIXTURE`, or `UNAVAILABLE`, and shows `PENDING_STAFF` separately as work
  state.
- [ ] Each returning-caller script requires confirmation before prior context
  is disclosed, and real callers require verified identity before any prior
  case/order detail is revealed; the browser fixture identity is visibly
  `DEMO_TRUSTED` and cannot be supplied by a client.
- [ ] Product-photo handling shows its true attachment state and never claims
  a WhatsApp flow without an approved integration.
- [ ] Same-room handoff has evidence for success, staff race, microphone
  denial, and no-operator timeout.
- [ ] The scripted SOS alert remains labelled as a workflow fixture; production
  risk evaluation remains shadow-only until the business staffing and review
  gate is complete.
- [ ] Exotel/SIP is shown only with controlled carrier evidence; otherwise the
  run sheet uses the browser live demo or deterministic transcript fallback.
- [ ] Outbound callback and sales follow-up remain disabled until controlled
  phone validation, explicit policy approval, and carrier reconciliation pass.
- [ ] Voice cloning remains outside this demo phase.

## Unresolved dependencies

The plan intentionally does not select a carrier configuration, storage
provider, business-system source, queue roster, or SOS policy. Those are
business and account decisions whose absence must remain visible in the demo.
They do not block the browser complaint vertical slice, except where the slice
would otherwise claim a phone call, received photo, account answer, or staffed
handoff.
