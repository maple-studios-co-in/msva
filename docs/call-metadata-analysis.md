# Call Metadata Analysis

Source file: `data/reports.csv`  
Records analyzed: 3,898 calls  
Period covered: 2026-04-01 04:39:36 to 2026-05-18 21:27:39

## Executive Summary

The current inbound support setup has a major availability and capacity gap. Only 883 of 3,898 calls were answered, which means the answer rate is 22.7%. The remaining 77.3% were either unanswered or missed.

This is a strong fit for a voice-agent layer. The immediate opportunity is not just replacing agent conversations, but answering every call consistently, especially outside human working hours and during peak call windows.

## Key Metrics

| Metric | Value |
| --- | ---: |
| Total calls | 3,898 |
| Unique callers | 2,069 |
| Answered calls | 883 |
| Answer rate | 22.7% |
| Unanswered calls | 2,808 |
| Missed calls | 207 |
| Voicemail calls | 838 |
| Calls with recording | 883 |
| Median inbound duration | 39 sec |
| Median answered-call duration | 115 sec |
| Average answered-call duration | 136 sec |
| Repeat callers with 2+ calls | 789 |
| Calls from repeat callers | 2,618 |

## Status Distribution

| Status | Calls | Share |
| --- | ---: | ---: |
| Unanswered | 2,808 | 72.0% |
| Answered | 883 | 22.7% |
| Missed call | 207 | 5.3% |

Interpretation:

- Most inbound demand is not reaching a human agent.
- The voice agent should be designed as a first-response layer for all calls, not only as a deflection tool after agent overload.
- Missed and unanswered calls should be treated as recoverable demand.

## Time-of-Day Pattern

| Time Band | Calls | Answered | Answer Rate | Voicemail Rate |
| --- | ---: | ---: | ---: | ---: |
| 00:00-05:59 | 14 | 0 | 0.0% | 64.3% |
| 06:00-09:59 | 445 | 0 | 0.0% | 61.8% |
| 10:00-13:59 | 1,605 | 546 | 34.0% | 12.3% |
| 14:00-17:59 | 1,317 | 337 | 25.6% | 3.6% |
| 18:00-23:59 | 517 | 0 | 0.0% | 59.6% |

Interpretation:

- Demand starts before agents are answering calls.
- 10:00-14:00 is the heaviest call window.
- Even during the main working window, answer rates are low.
- After 18:00, calls still continue but no calls are answered.

Voice-agent implication:

- The MVP should run 24x7.
- Outside office hours, the agent should capture request details and create a callback/ticket.
- During office hours, the agent should try to resolve routine queries first and forward only high-value or unresolved calls.

## Day-of-Week Pattern

| Day | Calls | Answered | Answer Rate |
| --- | ---: | ---: | ---: |
| Monday | 777 | 149 | 19.2% |
| Tuesday | 566 | 155 | 27.4% |
| Wednesday | 517 | 132 | 25.5% |
| Thursday | 552 | 166 | 30.1% |
| Friday | 580 | 150 | 25.9% |
| Saturday | 571 | 131 | 22.9% |
| Sunday | 335 | 0 | 0.0% |

Interpretation:

- Monday has the highest load and one of the weakest answer rates.
- Sunday has meaningful demand but no answered calls.
- Weekend and after-hours coverage should be part of the business case.

## Repeat Caller Behavior

Repeat callers are a major signal.

| Repeat Threshold | Callers | Calls | Share of All Calls |
| --- | ---: | ---: | ---: |
| 2+ calls | 789 | 2,618 | 67.2% |
| 3+ calls | 388 | 1,816 | 46.6% |
| 5+ calls | 123 | 931 | 23.9% |
| 10+ calls | 19 | 290 | 7.4% |

Interpretation:

- A small group of callers generates a large share of traffic.
- Many repeat calls are likely follow-ups caused by missed calls, unresolved issues, delivery uncertainty, or status checks.
- The voice agent should recognize returning numbers and avoid making callers repeat the same context.

Voice-agent implication:

- Store caller history by phone number.
- On repeat calls, start with context: open complaint, last order query, pending callback, or previous missed call.
- Prioritize repeat callers for faster routing or proactive status updates.

## Duration Pattern

| Duration Threshold | Calls | Share |
| --- | ---: | ---: |
| 5 sec or less | 511 | 13.1% |
| 10 sec or less | 792 | 20.3% |
| 15 sec or less | 1,005 | 25.8% |
| 30 sec or less | 1,671 | 42.9% |
| 60 sec or less | 2,491 | 63.9% |
| 120 sec or less | 3,110 | 79.8% |

Interpretation:

- A large share of calls are short, likely because callers abandon, hit IVR/voicemail, or fail to reach an agent.
- The first 15-30 seconds are critical.

Voice-agent implication:

- The greeting must be short.
- Caller intent detection should happen immediately.
- The agent should ask one focused opening question, not a long menu.

## Agent and Routing Observations

Agent records show:

| Agent | Answered Calls |
| --- | ---: |
| Payal | 856 |
| Vishakha | 27 |

Outgoing picked numbers:

| Number | Picked Calls |
| --- | ---: |
| 9891982476 | 856 |
| 6260618329 | 27 |

Interpretation:

- The live handling load appears concentrated on one primary agent/number.
- This creates a bottleneck during peak hours.
- Transfer fields show `transfer_picked = 0` for every record, so the dataset does not show successful live-transfer behavior.

Voice-agent implication:

- The first version should not depend only on live transfer.
- It should support ticket creation and callback scheduling when agents are unavailable.
- Human handoff should include a structured call summary so agents do not restart discovery from zero.

## Telephony and Setup Issues

Several routing/system states appear in the data:

| Department / State | Calls |
| --- | ---: |
| DEPARTMENT-depart | 2,013 |
| VOICEMAIL-voice | 838 |
| NEXT_EVENT | 396 |
| DEPARTMENT-20250150_depart | 208 |
| DID_EXPIRED | 202 |
| IVR-depart | 190 |
| OFFICEHOURS_NOT_VALID | 33 |
| PORTS_NOT_AVAILABLE | 5 |

Interpretation:

- `DID_EXPIRED`, `PORTS_NOT_AVAILABLE`, and office-hour states indicate telephony configuration issues or operational constraints.
- These should be cleaned up before or during voice-agent deployment, otherwise the AI layer may inherit broken routing behavior.

## Recommended Voice-Agent MVP from This Data

The metadata supports an MVP focused on availability, triage, and structured capture.

Priority features:

- 24x7 inbound answering.
- Hindi/Hinglish opening conversation.
- Caller identification by phone number.
- Caller type detection: distributor, retailer, customer, unknown.
- Intent detection for delivery status, order status, complaint, product availability, invoice/payment query, and general inquiry.
- Complaint and request capture.
- Callback ticket creation when human agents are offline or unavailable.
- Live transfer only for qualified escalation cases.
- Call summary generation for human agents.
- Repeat caller recognition.
- After-hours callback workflow.

## Suggested Escalation Logic

Escalate to a human agent when:

- Caller explicitly asks for an agent.
- Caller reports serious product quality or food safety issues.
- Caller is a high-frequency repeat caller with unresolved context.
- Caller has payment, invoice, or distributor dispute language.
- The caller is angry or dissatisfied.
- The AI cannot classify the intent confidently.
- Backend systems are unavailable for an order or account-specific lookup.

## Expected Business Impact

The strongest measurable impact should come from:

- Capturing currently unanswered demand.
- Reducing repeat calls caused by non-response.
- Handling after-hours and Sunday calls.
- Reducing load on the primary support agent.
- Creating cleaner issue records before human follow-up.

The current answer gap suggests the voice agent should initially be positioned as a coverage and triage layer, then expanded into full resolution once order, distributor, and complaint systems are integrated.

## Data Limitations

This file is call metadata only. It does not include:

- Call reason or intent.
- Conversation transcript.
- Complaint category.
- Resolution outcome.
- Customer satisfaction.
- Distributor/customer master data.
- Whether unanswered callers were later contacted.

Because of this, the analysis can identify operational gaps and routing patterns, but it cannot yet estimate exact automation rate by issue type. For that, call recordings, transcripts, or manually tagged call reasons are needed.

## Next Data Needed

To design the production voice-agent flow, collect:

- Top call reasons from manual agents.
- Sample recordings or transcripts from answered calls.
- Complaint categories and historical ticket data.
- Distributor/customer master list.
- Order and delivery status data source.
- Current business hours and escalation numbers.
- Existing CRM/ERP fields required for ticket creation.
