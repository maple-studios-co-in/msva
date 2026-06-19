# Calling Roadmap

This is the master checklist for taking the MSVA voice agent from the current text-demo + telephony-skeleton state to handling real inbound calls in production. Items are grouped by phase; each phase is independently shippable.

Treat boxes as living — check them off as you go, and add new items inline rather than starting a side document.

---

## Phase 0 — Skeleton (done)

- [x] Streaming agent (`streamChat`) + SSE endpoint in `apps/api`
- [x] Tool registry + dispatch (`apps/api/src/tools/`)
- [x] Deterministic tool synthesis from inferred outcome
- [x] Telephony service (`apps/telephony`) with Exotel webhook + media-stream WS
- [x] Pluggable ASR / TTS adapter interfaces (Sarvam stubs)
- [x] Energy-based endpointer + basic barge-in
- [x] All four packages typecheck (`@msva/shared`, `@msva/api`, `@msva/web`, `@msva/telephony`)

---

## Phase 1 — Browser-only voice loop (no PSTN yet)

Goal: prove the ASR → LLM → TTS chain works in Hinglish with acceptable latency before paying for a phone number.

### Sarvam ASR (real)
- [x] Get Sarvam API key, store in `apps/telephony/.env` (and `apps/api/.env` for the dashboard playground)
- [x] First cut: REST `/speech-to-text` on `endpoint()` flush — wraps buffered PCM in a WAV header (saaras:v3, `mode=transcribe`)
- [ ] Upgrade to streaming WebSocket for partial transcripts + lower perceived latency
- [ ] Forward `feed()` PCM frames as binary WS messages
- [ ] Parse `partial` + `final` JSON responses into `AsrEvent`s
- [ ] Unit-test with a captured 8kHz PCM sample (use `check-sarvam.mjs` as the starting point)
- [ ] Measure end-to-end ASR latency on a 5-second utterance (target < 600ms)

### Sarvam TTS (real)
- [x] Audition voices via the dashboard Voice Playground + audio buttons on the VA Demo
- [ ] A/B chosen voice with an internal customer-facing reviewer before locking it in
- [x] HTTP streaming endpoint `/text-to-speech/stream` wired in `apps/telephony/src/tts/sarvam.ts`
- [x] `output_audio_codec=linear16` + `speech_sample_rate=8000` → raw PCM, matches Exotel directly (no resampling needed)
- [x] Sentence-boundary chunking ships first audio before the LLM finishes
- [ ] Measure time-to-first-byte on a real call (target < 400ms)
- [ ] Upgrade to WebSocket `/text-to-speech/ws` for warm-connection latency on multi-turn calls

### Browser harness
- [ ] Add a "voice mode" toggle in `apps/web` that captures mic + plays PCM
- [ ] Use the same `agentClient.ts` (SSE) so the browser path mirrors telephony
- [ ] Side-by-side panel showing live transcript + agent reply + latencies

### Latency telemetry
- [ ] Populate `CallTurn` fields in `pipeline.ts`: `asrMs`, `llmFirstTokenMs`, `llmTotalMs`, `ttsFirstByteMs`, `ttsTotalMs`, `interrupted`
- [ ] Log per-turn to stdout in dev
- [ ] Persist per-turn in Phase 3

**Exit criteria:** end-to-end voice loop in browser, sub-1.5s perceived response time, Hinglish ASR accuracy > 85% on a 20-call sample.

---

## Phase 2 — First real call

### Exotel setup
- [ ] Create Exotel account (Indian region)
- [ ] Buy a single DID for testing
- [ ] Configure Voicebot Applet → set URL to `https://<host>/exotel/incoming`
- [ ] Expose dev service via ngrok (set `PUBLIC_WS_HOST` + `PUBLIC_WS_SCHEME=wss`)
- [ ] Verify ExoML response is accepted by Exotel
- [ ] Verify media-stream WS connects and audio flows both ways
- [ ] Capture a real call recording for ASR tuning

### One intent end-to-end
- [ ] Pick `delivery_delay` as the launch intent (lowest risk)
- [ ] Replace deterministic tool synthesis: have the LLM emit JSON tool calls
- [ ] Wire `create_ticket` to the real helpdesk (see Phase 4)
- [ ] Verify ticket appears in the helpdesk after a real call
- [ ] Add a transfer-to-human escape hatch for anything else

### VAD upgrade
- [ ] Replace `vad.ts` energy detector with Silero VAD (via `onnxruntime-node`)
- [ ] Calibrate threshold for phone-quality audio
- [ ] Confirm barge-in cancels TTS within 200ms of caller speech
- [ ] Test with background noise (Indian street, shop, factory floor)

**Exit criteria:** the team can dial the DID, ask about a delivery, and get a real ticket created.

---

## Phase 3 — Production reliability

### State + persistence
- [ ] Move `ConversationState` from in-memory to Redis, keyed on `callSid`
- [ ] Implement state recovery on service restart mid-call
- [ ] CRM caller-identity lookup on call start (phone → caller profile)
- [ ] Pull last 3 call summaries into the system prompt as context

### Provider fallback
- [ ] Add Bhashini (AI4Bharat) as backup ASR
- [ ] Add ElevenLabs Multilingual or Azure Neural as backup TTS
- [ ] Circuit-breaker on primary provider error rate (>5% in 1 min → flip)
- [ ] Log provider used per turn

### Observability
- [ ] Persist per-turn `CallTurn` records (Postgres or ClickHouse)
- [ ] Persist full transcripts with timestamps
- [ ] Persist call recordings (with consent — see Compliance)
- [ ] Datadog / OpenTelemetry traces with `callSid` as trace id
- [ ] Alerts: call failure rate, ASR error rate, average first-token latency

### Reliability
- [ ] Graceful shutdown that drains in-flight calls
- [ ] Health checks for ASR / TTS / LLM upstream in `/health`
- [ ] Load test: 50 concurrent calls
- [ ] Memory + CPU profiling under load

**Exit criteria:** a service restart never drops a call, and you can replay any prod call from its `callSid`.

---

## Phase 3.5 — Call Inspector (Thinkly-inspired)

See [platform-features.md](./platform-features.md) for the rationale on each.

### Call detail drawer
- [ ] Slide-out right drawer over the call-history table
- [ ] Tabs: Call Details / Profile / Performance / Step Breakdown
- [ ] Drawer header: caller name, phone, status badge, lead source, time ago

### Recording + transcript
- [ ] Persist call recordings (WAV or Opus on S3 / R2)
- [ ] Persist time-aligned transcripts with speaker tags
- [ ] HTML5 audio player with scrubber + download in the drawer
- [ ] Speaker-bubble transcript with copy-per-bubble
- [ ] Consent line in opening greeting (required before recording goes live)

### Post-call extraction pass
- [ ] Per-agent extraction schema (field name, type, optional enum)
- [ ] Post-call LLM pass that fills the schema from the transcript
- [ ] Render fields as cards in the Profile tab
- [ ] Same pass also emits `qualificationSignals[]` and `nextSteps[]` (rendered in Call Details)

### Performance scoring (judge)
- [ ] Per-agent rubric (metric name, judge prompt, target/optimal thresholds)
- [ ] Post-call judge LLM pass that scores each rubric item with a one-line justification
- [ ] Render scores as critical/target/optimal bars in the Performance tab

---

## Phase 4 — All intents + tools

### Helpdesk integration (pick one)
- [ ] Decide: Freshdesk vs Zoho Desk vs Salesforce Service Cloud vs Google-Sheet-for-now
- [ ] Implement real `create_ticket` in `apps/api/src/tools/crm.ts`
- [ ] Implement real `lookup_order` against the OMS/DMS
- [ ] Implement real `check_inventory` against the warehouse system
- [ ] Decide WhatsApp provider (Gupshup vs Wati vs Meta direct)
- [ ] Implement real `send_whatsapp_confirmation`

### Human transfer
- [ ] Decide queue routing (one queue vs intent-keyed queues)
- [ ] Implement warm transfer in `transfer_to_human` (Exotel `<Dial>` with whisper)
- [ ] Test cold transfer fallback
- [ ] Brief human agents on context-handoff format

### Intent coverage
- [ ] `delivery_delay` live (Phase 2)
- [ ] `product_availability` live
- [ ] `product_complaint` live with high-urgency escalation
- [ ] `invoice_payment` live with hot transfer to accounts queue
- [ ] `scheme_pricing` live
- [ ] `order_status` live
- [ ] Catchall fallback ("transfer to human") for `unknown`

**Exit criteria:** every intent has an end-to-end path, with either tool resolution or human transfer.

---

## Phase 5 — Dashboard, QA, recording

### Web dashboard extensions
- [ ] Live-calls view (currently active calls + their state)
- [ ] Per-call drill-down: transcript + audio + per-turn latencies
- [ ] QA review queue: flag escalated / failed / low-confidence calls for human review
- [ ] Voice-agent vs human-agent KPI comparison
- [ ] Cost dashboard: per-minute telephony + ASR + LLM + TTS

### Recording
- [ ] Decide retention period (30 / 90 / 365 days)
- [ ] Encrypt recordings at rest
- [ ] Encrypt transcripts at rest
- [ ] Access controls on the QA dashboard (audit log who listened to what)
- [ ] PII redaction pipeline for logs

---

## Phase 5.5 — Platform expansion (Thinkly-inspired)

### Voice Agents as first-class entities
- [ ] `VoiceAgent` entity: name, system prompt, voice, language, extraction schema, performance rubric, retry policy
- [ ] Each call references an agent by id
- [ ] Admin UI (or YAML-in-git for v1) to create/edit agents

### CRM Webhook (lowest-common-denominator integration)
- [ ] Configurable per customer: URL, secret, retry policy, payload schema
- [ ] Pushes completed-call payloads (profile + signals + transcript + scoring)
- [ ] Signed with HMAC so the receiver can verify
- [ ] Developer-docs page describing the payload

### Integrations page
- [ ] Card-based UI: HubSpot, Salesforce, Teams, CRM Webhook
- [ ] Active / Not Connected / Coming Soon states
- [ ] Counter header: Available / Connected / Pending

### Post-call workflow steps
- [ ] State machine per agent: configurable steps (CRM Save → WhatsApp → Email → Calendar)
- [ ] Each step: succeed / fail / skipped with reason
- [ ] Render as the Step Breakdown tab

### Cost + wallet
- [ ] Per-call cost calculator (telephony + ASR + LLM + TTS)
- [ ] Wallet entity: purchased balance, debits, transaction log
- [ ] Header pill + hover popover (lifetime purchased / consumed / daily average)
- [ ] CHARGED column in call history

### Outcome / status split
- [ ] Add `callStatus` enum (queued / ringing / in_progress / completed / no_answer / needs_retry / failed)
- [ ] Keep `agentOutcome` as the business outcome, separate
- [ ] Update dashboard filters

### Retry workflow
- [ ] Retry policy on each agent: max retries, backoff, time-of-day windows
- [ ] Worker process re-dials "needs retry" calls at the next eligible window
- [ ] "Next retry at" timestamp visible in the drawer

### Dashboard filters + polish
- [ ] LIVE / TEST toggle
- [ ] Date range picker
- [ ] Campaign filter (once campaigns exist)
- [ ] Server-paginated call history with rows-per-page (sticky in localStorage)
- [ ] Intent distribution pie chart
- [ ] Performance trends multi-line over time
- [ ] RNR as a separate KPI
- [ ] Lead Source tag per call (inbound / bulk_campaign / api / manual / retry)

### Phone Numbers + Bulk Campaigns
- [ ] Phone Numbers inventory page (DID, assigned agent, monthly cost, volume)
- [ ] Bulk Campaign entity: name, agent, target list, start time, throttle
- [ ] Dialer worker pulling from the target list

---

## Phase 6 — Compliance + deployment

### Compliance (India-specific)
- [ ] Add consent line to greeting: "Yeh call recorded ho rahi hai, training aur quality ke liye"
- [ ] DPDP Act review: data retention, consent, deletion-on-request
- [ ] TRAI DLT registration (only required for outbound)
- [ ] Exotel ToS review for recording
- [ ] DPO sign-off

### Deployment
- [ ] Dockerfile for `apps/api`
- [ ] Dockerfile for `apps/telephony`
- [ ] Dockerfile for `apps/web`
- [ ] CI: typecheck + build on every PR
- [ ] Staging environment with a test DID
- [ ] Production environment
- [ ] Secrets manager (AWS Secrets Manager / Doppler / 1Password)
- [ ] Logging aggregation
- [ ] Cost alerting

---

## Phase 7 — Pilot → rollout

- [ ] Internal team test calls (10 calls / day for 1 week)
- [ ] Friendly customer pilot: one distributor route, one intent
- [ ] Expand to all intents for that route
- [ ] Expand to second route
- [ ] Full inbound rollout
- [ ] Post-launch retro

---

## Phase 8 — Outbound (future)

- [ ] DLT consent collection workflow
- [ ] Outbound campaign engine
- [ ] Callback scheduler (from missed-call list)
- [ ] Payment reminder flow
- [ ] Order confirmation flow
- [ ] Compliance review for each outbound use case

---

## Cross-cutting

### Cost model
- [ ] Per-minute cost spreadsheet: telephony + ASR + LLM + TTS, by provider
- [ ] Break-even analysis vs current human-agent cost
- [ ] Monthly cost forecast at 1k / 10k / 100k calls

### Prompt + model lifecycle
- [ ] Prompt versioning (commit prompts to git, tag with `agent_version`)
- [ ] A/B framework: route N% of calls to a new prompt and compare metrics
- [ ] Regression suite: the four demo calls run through the new pipeline and assert outcomes
- [ ] Eval harness on captured real-call transcripts

### Security
- [ ] No API keys in committed `.env` files
- [ ] Rotate keys quarterly
- [ ] Pen test before public rollout
