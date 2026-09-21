import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { CallAssessmentResponse } from "@msva/shared";
import { AssessmentContent } from "./CallAssessmentPanel.js";
import { assessmentView } from "./assessmentView.js";

const response: CallAssessmentResponse = {
  capability: { enabled: true, available: true, reason: null },
  eligibility: { eligible: true, reason: null },
  current: true,
  assessment: {
    id: "assessment-1", callId: "call-1", status: "SUCCEEDED", requestedAt: "2026-09-21T10:00:00.000Z", completedAt: "2026-09-21T10:00:05.000Z", leaseExpiresAt: null,
    retryable: false, requestedModel: "jev-1.13.0", returnedModel: "jev-1.13.0", rubricVersion: "msva-post-call-v1", inputHash: "hash", errorCode: null,
    result: {
      repetition: { choice: "not_repetitive", probabilities: { repetitive: 0.1, not_repetitive: 0.8, insufficient_context: 0.1 }, confidence: 0.8 },
      callerSentiment: { choice: "frustrated", probabilities: { positive: 0.05, neutral: 0.1, frustrated: 0.8, unclear: 0.05 }, confidence: 0.8 },
      followUpNeed: { choice: "indicated", probabilities: { indicated: 0.8, not_indicated: 0.1, unclear: 0.1 }, confidence: 0.8 },
      ticketCreationClaim: { choice: "claimed", probabilities: { claimed: 0.8, not_claimed: 0.1, unclear: 0.1 }, confidence: 0.8 },
      journey: { choice: "consumer_complaint", probabilities: { consumer_complaint: 0.8, retailer_enquiry: 0.05, distributor_support: 0.05, sales_interest: 0.05, unclear: 0.05 }, confidence: 0.8 },
      urgency: { choice: "possible_safety", probabilities: { possible_safety: 0.8, routine: 0.1, unclear: 0.1 }, confidence: 0.8 },
      possibleUnsupportedTicketClaim: true,
      linkedTicketRecorded: false
    }
  }
};

describe("AssessmentContent", () => {
  it("renders all six advisory classifications with a polite live region and no safety claim", () => {
    const html = renderToStaticMarkup(createElement(AssessmentContent, {
      response, view: assessmentView(response, false, new Date()), busy: false, onAssess: () => {}
    }));

    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Advisory AI assessment — review the transcript.");
    expect(html).toContain("Repetition");
    expect(html).toContain("Caller sentiment");
    expect(html).toContain("Follow-up need");
    expect(html).toContain("Ticket creation claim");
    expect(html).toContain("Journey");
    expect(html).toContain("Possible safety concern — review");
    expect(html).toContain("Possible unsupported ticket claim — review persisted ticket records.");
    expect(html).toContain("No linked persisted ticket record");
    expect(html).toContain("Requested model");
    expect(html).toContain("Rubric version");
    expect(html).toContain("Completed");
    expect(html).not.toContain("All clear");
  });
});
