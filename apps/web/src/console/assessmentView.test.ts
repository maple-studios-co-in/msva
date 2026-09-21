import { describe, expect, it } from "vitest";
import type { CallAssessmentResponse } from "@msva/shared";
import { assessmentView, assessmentWakeDelay, responseBelongsToCall, savedCallAssessmentRevision } from "./assessmentView.js";

const base: CallAssessmentResponse = {
  capability: { enabled: true, available: true, reason: null },
  eligibility: { eligible: true, reason: null },
  assessment: null,
  current: true
};

const succeeded: NonNullable<CallAssessmentResponse["assessment"]> = {
  id: "assessment-1",
  callId: "call-1",
  status: "SUCCEEDED",
  requestedAt: "2026-09-21T10:00:00.000Z",
  completedAt: "2026-09-21T10:00:05.000Z",
  leaseExpiresAt: null,
  retryable: false,
  requestedModel: "jev-1.13.0",
  returnedModel: "jev-1.13.0",
  rubricVersion: "msva-post-call-v1",
  inputHash: "hash",
  errorCode: null,
  result: {
    repetition: { choice: "not_repetitive", probabilities: { repetitive: 0.1, not_repetitive: 0.8, insufficient_context: 0.1 }, confidence: 0.8 },
    callerSentiment: { choice: "neutral", probabilities: { positive: 0.1, neutral: 0.8, frustrated: 0.05, unclear: 0.05 }, confidence: 0.8 },
    followUpNeed: { choice: "unclear", probabilities: { indicated: 0.2, not_indicated: 0.2, unclear: 0.6 }, confidence: 0.6 },
    ticketCreationClaim: { choice: "not_claimed", probabilities: { claimed: 0.1, not_claimed: 0.8, unclear: 0.1 }, confidence: 0.8 },
    journey: { choice: "retailer_enquiry", probabilities: { consumer_complaint: 0.05, retailer_enquiry: 0.8, distributor_support: 0.05, sales_interest: 0.05, unclear: 0.05 }, confidence: 0.8 },
    urgency: { choice: "routine", probabilities: { possible_safety: 0.05, routine: 0.9, unclear: 0.05 }, confidence: 0.9 },
    possibleUnsupportedTicketClaim: false,
    linkedTicketRecorded: false
  }
};

describe("assessmentView", () => {
  it("polls a queued automatic job before an assessment row exists while keeping manual assessment available", () => {
    const response = {
      ...base,
      automaticJob: { state: "PENDING" as const, dueAt: "2026-09-21T10:00:10.000Z", attempts: 0, reason: null, leaseExpiresAt: null, stalled: false }
    };

    expect(assessmentView(response, true, new Date("2026-09-21T10:00:00.000Z"))).toMatchObject({ kind: "queued", shouldPoll: true, canRequest: true, actionLabel: "Run assessment" });
    expect(assessmentWakeDelay(response, new Date("2026-09-21T10:00:00.000Z"))).toBe(2500);
  });

  it("shows a stalled automatic worker without disabling the manual action", () => {
    const response = {
      ...base,
      automaticJob: { state: "RUNNING" as const, dueAt: "2026-09-21T10:00:00.000Z", attempts: 1, reason: "LEASE_EXPIRED", leaseExpiresAt: "2026-09-21T10:00:01.000Z", stalled: true }
    };
    expect(assessmentView(response, true, new Date("2026-09-21T10:01:00.000Z"))).toMatchObject({ kind: "interrupted", shouldPoll: false, canRequest: true, actionLabel: "Run assessment" });
  });

  it("keeps a historical result visibly stale while its replacement is queued", () => {
    const response = {
      ...base, assessment: succeeded, current: false,
      automaticJob: { state: "PENDING" as const, dueAt: "2026-09-21T10:00:10.000Z", attempts: 0, reason: null, leaseExpiresAt: null, stalled: false }
    };
    expect(assessmentView(response, true, new Date())).toMatchObject({ kind: "stale", shouldPoll: true, showResult: true, liveMessage: null });
    expect(assessmentView(response, true, new Date()).detail).toContain("Automatic assessment queued");
  });

  it("keeps a current manual success ahead of a terminal automatic job", () => {
    const response = {
      ...base, assessment: succeeded, current: true,
      automaticJob: { state: "FAILED" as const, dueAt: "2026-09-21T10:00:10.000Z", attempts: 1, reason: "AUTH_FAILED", leaseExpiresAt: null, stalled: false }
    };
    expect(assessmentView(response, true, new Date())).toMatchObject({ kind: "succeeded", showResult: true, shouldPoll: false });
  });

  it("shows a polite live status and keeps polling during an unexpired assessment", () => {
    const view = assessmentView({
      ...base,
      assessment: { ...succeeded, status: "RUNNING", completedAt: null, leaseExpiresAt: "2026-09-21T10:01:00.000Z", retryable: true }
    }, true, new Date("2026-09-21T10:00:30.000Z"));

    expect(view).toMatchObject({ kind: "running", canRequest: false, shouldPoll: true, liveMessage: "Assessment running. Results will appear here." });
  });

  it("offers a supervisor manual recovery when an otherwise non-retryable running lease expires", () => {
    const response = {
      ...base,
      assessment: { ...succeeded, status: "RUNNING" as const, completedAt: null, leaseExpiresAt: "2026-09-21T10:00:00.000Z", retryable: false, result: null }
    };

    expect(assessmentView(response, true, new Date("2026-09-21T10:00:01.000Z"))).toMatchObject({ kind: "interrupted", canRequest: true, actionLabel: "Try assessment again" });
    expect(assessmentView(response, false, new Date("2026-09-21T10:00:01.000Z"))).toMatchObject({ kind: "interrupted", canRequest: false, actionLabel: null });
  });

  it("does not offer an assessment action when the capability is disabled", () => {
    const view = assessmentView({
      ...base,
      capability: { enabled: false, available: false, reason: "MISSING_API_KEY" }
    }, true, new Date());

    expect(view).toMatchObject({ kind: "unavailable", canRequest: false, shouldPoll: false, headline: "Assessment unavailable" });
    expect(view.detail).toContain("configuration");
  });

  it("keeps a saved result readable when assessments are explicitly turned off", () => {
    const view = assessmentView({
      ...base,
      capability: { enabled: false, available: false, reason: "DISABLED" },
      assessment: succeeded,
      current: false
    }, true, new Date());

    expect(view).toMatchObject({ kind: "unavailable", canRequest: false, showResult: true, headline: "Assessment is turned off" });
    expect(view.detail).toContain("stale");
  });

  it("lets a supervisor retry a saved failure without hiding the safe failure state", () => {
    const view = assessmentView({
      ...base,
      assessment: { ...succeeded, status: "FAILED", completedAt: "2026-09-21T10:00:05.000Z", errorCode: "PROVIDER_UNAVAILABLE", retryable: true }
    }, true, new Date());

    expect(view).toMatchObject({ kind: "failed", canRequest: true, actionLabel: "Try assessment again", headline: "Assessment could not be completed" });
  });

  it("keeps a stale successful result visible and asks for review rather than asserting current facts", () => {
    const view = assessmentView({ ...base, assessment: succeeded, current: false }, true, new Date());

    expect(view).toMatchObject({ kind: "stale", canRequest: true, actionLabel: "Assess again", headline: "Saved assessment is stale" });
    expect(view.detail).toContain("Transcript or recorded facts changed");
  });

  it("keeps the manual action out of a viewer's state while preserving readable results", () => {
    const view = assessmentView({ ...base, assessment: succeeded }, false, new Date());

    expect(view).toMatchObject({ kind: "succeeded", canRequest: false, showResult: true });
  });

  it("rejects a late response for the call that is no longer open", () => {
    expect(responseBelongsToCall("call-2", "call-1", { ...base, assessment: succeeded })).toBe(false);
    expect(responseBelongsToCall("call-1", "call-1", { ...base, assessment: succeeded })).toBe(true);
    expect(responseBelongsToCall("call-1", "call-1", { ...base, assessment: null })).toBe(true);
  });

  it("schedules repeated polling for an active lease and wakes after a failed cooldown", () => {
    const now = new Date("2026-09-21T10:00:30.000Z");
    expect(assessmentWakeDelay({ ...base, assessment: { ...succeeded, status: "RUNNING", completedAt: null, leaseExpiresAt: "2026-09-21T10:01:00.000Z" } }, now)).toBe(2500);
    expect(assessmentWakeDelay({ ...base, assessment: { ...succeeded, status: "RUNNING", completedAt: null, leaseExpiresAt: "2026-09-21T10:00:00.000Z" } }, now)).toBeNull();
    expect(assessmentWakeDelay({ ...base, assessment: { ...succeeded, status: "FAILED", completedAt: "2026-09-21T10:00:10.000Z", retryable: false } }, now)).toBe(10000);
  });

  it("changes the saved-call revision for completion, transcript, language, and linked-ticket evidence", () => {
    const call = {
      status: "IN_PROGRESS", endedAt: null, language: "hi-IN",
      utterances: [{ id: "utterance-1", seq: 1, text: "Hello" }],
      tickets: []
    };
    const revision = savedCallAssessmentRevision(call);

    expect(savedCallAssessmentRevision({ ...call, status: "COMPLETED", endedAt: "2026-09-21T10:00:00.000Z" })).not.toBe(revision);
    expect(savedCallAssessmentRevision({ ...call, utterances: [{ id: "utterance-1", seq: 1, text: "Changed" }] })).not.toBe(revision);
    expect(savedCallAssessmentRevision({ ...call, language: "en-IN" })).not.toBe(revision);
    expect(savedCallAssessmentRevision({ ...call, tickets: [{ id: "ticket-1" }] })).not.toBe(revision);
  });
});
