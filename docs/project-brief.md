# Madhu Sudhan Voice Agent - Project Brief

## 1. Background

Madhu Sudhan is a dairy company with a distribution and customer network across North India. The company receives inbound support calls from distributors, retailers, end customers, and other stakeholders. These calls are currently handled by manual support agents.

The proposed solution is a voice agent that answers inbound calls first, understands the caller's requirement, collects necessary information, resolves routine issues, and forwards only selected cases to a human support agent.

## 2. Objective

Build an AI voice layer between inbound callers and manual support agents.

The voice agent should:

- Pick up inbound calls.
- Greet the caller in a natural, brand-appropriate way.
- Understand whether the caller is a distributor, retailer, customer, or unknown caller.
- Ask follow-up questions to identify the issue.
- Resolve routine queries automatically.
- Register complaints or requests when needed.
- Escalate to a human agent only when required.

## 3. Caller Segments

### Distributors

Common needs:

- Order status.
- Delivery delay.
- Stock availability.
- Invoice or payment status.
- Damaged goods.
- Route or logistics issues.
- Scheme or pricing questions.

### Retailers

Common needs:

- New supply request.
- Product availability.
- Damaged or expired stock.
- Distributor contact details.
- Pricing, margin, or scheme queries.

### End Customers

Common needs:

- Product quality complaints.
- Product availability near their location.
- Feedback or suggestions.
- Packaging, expiry, or freshness concerns.
- Refund or replacement request routing.

### Unknown Callers

Common needs:

- General inquiry.
- Wrong number.
- Business partnership inquiry.
- Job inquiry.
- Unclear or noisy calls.

## 4. High-Level Call Flow

1. Voice agent answers the call.
2. Agent greets the caller and asks how it can help.
3. Agent identifies caller type and intent.
4. Agent asks required follow-up questions.
5. Agent checks available data or records the request.
6. Agent resolves the call or confirms next steps.
7. Agent escalates to a human support agent if needed.
8. Agent logs call summary, caller details, intent, outcome, and escalation reason.

## 5. Example Opening Script

Hello, Madhu Sudhan customer support mein aapka swagat hai. Main aapki madad ke liye AI assistant bol raha hoon. Kripya batayein, aap kis baare mein call kar rahe hain?

English fallback:

Hello, welcome to Madhu Sudhan customer support. I am the AI assistant here to help you. Please tell me what you are calling about.

## 6. Required Information by Intent

### Order or Delivery Status

- Caller name.
- Distributor or retailer code, if available.
- Mobile number.
- Order number, invoice number, or delivery location.
- Product category.
- Date of order or expected delivery.

### Complaint Registration

- Caller name.
- Mobile number.
- Caller type.
- Product name.
- Batch number or expiry date, if available.
- Location.
- Complaint type.
- Photo or evidence requirement, if supported by follow-up SMS or WhatsApp.

### Product Availability

- Caller location.
- Product name or category.
- Quantity required.
- Preferred delivery timeline.

### Payment or Invoice Query

- Distributor or retailer code.
- Invoice number.
- Billing date.
- Amount.
- Contact person.

## 7. Escalation Rules

The voice agent should forward the call to a human agent when:

- Caller directly asks to speak with a human.
- Caller is angry, abusive, distressed, or repeatedly dissatisfied.
- Product safety or serious quality issue is reported.
- Payment dispute involves high value or legal language.
- Caller identity cannot be verified for account-specific information.
- Agent confidence is low after follow-up questions.
- Caller repeats the same question multiple times without resolution.
- Backend system is unavailable for a required lookup.

## 8. Automation Candidates

Can be handled fully by the voice agent:

- Basic FAQs.
- Complaint intake and ticket creation.
- Order status lookup.
- Delivery ETA lookup.
- Product availability guidance.
- Distributor contact routing.
- Call summary and CRM update.
- Follow-up SMS or WhatsApp confirmation.

Should usually involve human review:

- Serious food safety complaints.
- Large distributor disputes.
- Refund approvals.
- Legal threats.
- Media or government authority calls.
- Repeated unresolved complaints.

## 9. Language Requirements

The agent should support:

- Hindi.
- English.
- Hinglish.

Future expansion may include Punjabi, Haryanvi, and other North Indian regional language patterns depending on call volume.

## 10. Integrations Needed

Likely system integrations:

- Telephony provider for inbound call handling and call transfer.
- Speech-to-text for live transcription.
- Text-to-speech for natural voice response.
- LLM or dialogue manager for intent handling.
- CRM or ticketing system for complaint creation.
- ERP or order management system for order and invoice status.
- WhatsApp or SMS provider for confirmation messages.
- Analytics dashboard for call outcomes and escalation rate.

## 11. MVP Scope

Recommended MVP:

- Hindi and Hinglish voice support.
- Inbound call greeting and intent classification.
- Distributor, retailer, and customer identification.
- Complaint registration.
- Order or delivery status request capture.
- Product availability inquiry capture.
- Human handoff.
- Call summary generation.
- Basic dashboard or CSV export for call logs.

Out of MVP:

- Full refund processing.
- Automated payment settlement.
- Complex distributor dispute resolution.
- Deep regional dialect support.
- Fully automated outbound calling.

## 12. Success Metrics

- Call containment rate: percentage of calls resolved without human handoff.
- Escalation accuracy: percentage of escalated calls that truly required a human.
- Average handling time reduction.
- Complaint registration accuracy.
- Caller satisfaction score.
- Missed call reduction.
- Manual agent workload reduction.

## 13. Open Questions

- Which telephony provider will be used?
- Does Madhu Sudhan already have CRM, ERP, or ticketing software?
- Are distributor codes and order data available through an API?
- What are the top 20 current call reasons by volume?
- What languages are most common in actual calls?
- Should the voice agent disclose that it is AI at the start of every call?
- What are the business hours and after-hours handling rules?
- What is the preferred escalation path: live transfer, callback ticket, or both?
