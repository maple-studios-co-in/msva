# MSVA Platform Guide

## Platform Vision

Madhu Sudhan receives inbound calls from distributors, retailers, and customers. Today, many calls are missed or unanswered. MSVA becomes the always-available first support layer.

The platform should:

- Answer every call.
- Understand caller type and intent.
- Resolve routine requests.
- Capture structured details.
- Create tickets and callbacks.
- Transfer serious cases to human agents.
- Give management visibility into call demand.

## MVP Demo Scope

Implemented in this version:

- [Live call data](live-call-data.md) from recorded phone and browser sessions,
  with automatic refresh and a demo-session filter.
- Separate illustrative sample analytics, clearly labelled.
- Hinglish voice-agent chat simulation.
- Dummy distributor, retailer, and customer calls.
- Honest unavailable responses for unconnected integrations.
- Handoff summary.
- Hosted Anthropic or local Ollama agent integration.
- Exotel/browser audio, speech recognition, speech synthesis and saved call transcripts.
- Saved support tickets and an authenticated support console.
- Fallback responses.

Not implemented yet:

- Live ERP/inventory integration; order lookup uses seeded snapshots.
- Provider-backed human transfer.
- External CRM synchronisation and email delivery of console login codes.
- WhatsApp/SMS sending.

## Client Demo Story

1. Open **Live call data** and choose **Start demo session**.
2. Make an Exotel phone call or browser microphone call.
3. Show its real status, duration, turns and saved-ticket count updating.
4. Review its transcript in the signed-in support console when available.
5. If showing **Sample analytics** or **VA Demo**, explain that these use
   illustrative historical figures or scripted scenarios, separate from the calls
   just made. Do not present sample percentages as the client's results.

## Target Production Workflow

### Distributor Call

```text
Distributor calls
  -> AI greets in Hinglish
  -> Identifies distributor by phone or code
  -> Detects order/delivery/payment intent
  -> Looks up ERP if available
  -> Resolves or creates ticket
  -> Sends SMS/WhatsApp confirmation
```

### Customer Complaint

```text
Customer calls
  -> AI captures product, batch, expiry, location
  -> If quality/safety issue, escalate
  -> Create priority complaint
  -> Send acknowledgement
  -> Human quality team follows up
```

### Retailer Availability

```text
Retailer calls
  -> AI captures product, quantity, location
  -> Checks distributor/stock source
  -> Shares next step
  -> Creates supply request if needed
```

## Success Metrics

Primary:

- Call answer coverage.
- Call containment rate.
- Human handoff rate.
- Repeat-call reduction.
- Average handling time.
- Complaint registration accuracy.

Secondary:

- After-hours demand captured.
- Sunday demand captured.
- Agent workload reduction.
- Callback SLA.
- Customer satisfaction.

## Recommended Roadmap

### Phase 1: Demo MVP

Current version.

Goal:

- Prove product direction to client.
- Align on use cases and call flows.

### Phase 2: Telephony Pilot

Add:

- Telephony provider.
- Real inbound number.
- STT/TTS.
- Call recordings.
- Basic ticket creation.

Goal:

- Run with limited traffic or after-hours traffic.

### Phase 3: Business System Integration

Add:

- Distributor/customer master.
- ERP order status.
- Product availability.
- Invoice/payment read-only lookup.
- WhatsApp/SMS confirmations.

Goal:

- Resolve high-volume routine calls.

### Phase 4: Production Operations

Add:

- Admin dashboard.
- Human-agent console.
- QA review workflow.
- Analytics warehouse.
- SLA monitoring.
- Role-based access.

Goal:

- Replace large parts of inbound manual discovery.

## Human Handoff Requirements

Every human handoff should include:

- Caller phone.
- Caller name if known.
- Caller type.
- Intent.
- Collected fields.
- Conversation summary.
- Sentiment/urgency.
- Escalation reason.
- Suggested next action.

This prevents the manual agent from restarting the call from zero.

## Recommended Production Stack

Frontend:

- React.
- Vite or Next.js.
- Recharts or ECharts.

Backend:

- Node.js API.
- PostgreSQL.
- Redis queue.
- Worker service for integrations.

AI:

- Ollama for local pilot or private deployment.
- Production-grade hosted model option if latency and quality require it.
- Separate STT/TTS providers for phone audio.

Infrastructure:

- Docker.
- Reverse proxy.
- Managed database.
- Centralized logs.
- Metrics and alerting.

## Risk Areas

- Hinglish and regional speech recognition quality.
- Noisy call audio.
- Caller frustration if the agent asks too many questions.
- ERP/CRM data availability.
- Live transfer reliability.
- Compliance around recording and AI disclosure.

## Product Principles

- Keep opening prompt short.
- Ask one question at a time.
- Never fake order/payment status.
- Escalate food safety and payment disputes.
- Recognize repeat callers.
- Always produce a useful summary.
- Prefer callback ticket over dead-end voicemail.
