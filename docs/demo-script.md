# Client Demo Script

## Setup

Open:

```text
http://localhost:5173
```

Keep API running:

```text
http://localhost:4100/health
```

## 1. Opening

"Madhu Sudhan currently gets inbound calls from distributors, retailers, and customers. The goal of this MVP is to show how an AI voice layer can answer calls first, understand the requirement in Hinglish, resolve routine cases, and transfer only real escalation cases to human agents."

## 2. Dashboard

Show Call Analytics.

Key talking points:

- "The metadata has 3,898 calls."
- "Only 22.7% were answered."
- "77.3% were missed or unanswered."
- "No calls were answered before 10 AM, after 6 PM, or on Sunday."
- "67.2% of call volume comes from repeat callers."

Client framing:

"So the first value of the voice agent is availability. It can answer every call, capture demand, and reduce repeat calls caused by non-response."

## 3. Distributor Delivery Delay Demo

Go to VA Demo.

Select:

```text
Rajesh Gupta
```

Click:

```text
Use sample caller line
```

Explain:

"The AI identifies this as a distributor delivery-delay case. Since there is no ERP integration yet, it does not invent a delivery status. It creates a ticket/callback path."

## 4. Customer Quality Complaint Demo

Select:

```text
Neha Sharma
```

Click:

```text
Use sample caller line
```

Explain:

"This is a product quality concern. The AI captures details but escalates because quality or food safety should not be fully automated."

## 5. Retailer Availability Demo

Select:

```text
Amit Dairy Store
```

Click:

```text
Share details
```

Explain:

"This is a routine availability/supply request. These are good candidates for full automation once distributor and stock data are connected."

## 6. Human Handoff Summary

Show the right-side summary panel.

Explain:

"When a human agent receives the transfer, they get caller type, phone, intent, urgency, escalation reason, and collected fields. The human does not need to restart discovery."

## 7. Platform Flow

Open Platform Flow.

Explain:

"Production architecture adds telephony, speech-to-text, text-to-speech, CRM/ticketing, ERP lookup, and WhatsApp/SMS confirmation around this same core decision layer."

## Closing

"The MVP shows the journey from raw call metadata to an AI-supported support operation. The recommended next step is a telephony pilot on limited traffic or after-hours calls."
