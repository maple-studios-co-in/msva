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

- Call analytics dashboard based on real metadata.
- Hinglish voice-agent chat simulation.
- Dummy distributor, retailer, and customer calls.
- Escalation rules.
- Handoff summary.
- Local Ollama LLM integration.
- Fallback responses.

Not implemented yet:

- Live phone number.
- Real audio streaming.
- Speech-to-text.
- Text-to-speech.
- ERP order lookup.
- CRM ticket creation.
- WhatsApp/SMS sending.

## Client Demo Story

1. Show the dashboard.
2. Explain that only 22.7% of calls were answered in the provided metadata.
3. Highlight peak demand, repeat callers, and after-hours/Sunday gaps.
4. Open the VA Demo screen.
5. Pick a distributor delivery-delay call.
6. Use the sample caller line.
7. Show that the AI captures the issue and creates a ticket/callback path.
8. Pick a customer quality complaint.
9. Show that the AI escalates to a human because quality complaints are sensitive.
10. Show the handoff summary.

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
