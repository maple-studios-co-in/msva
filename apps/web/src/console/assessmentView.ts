import type { CallAssessmentResponse } from "@msva/shared";

export type AssessmentView = {
  kind: "unavailable" | "ineligible" | "ready" | "queued" | "running" | "interrupted" | "failed" | "stale" | "succeeded";
  headline: string;
  detail: string;
  liveMessage: string | null;
  canRequest: boolean;
  actionLabel: string | null;
  shouldPoll: boolean;
  showResult: boolean;
};

const COOLDOWN_MS = 30_000;
const POLL_INTERVAL_MS = 2500;

const ineligibleDetail: Record<Exclude<CallAssessmentResponse["eligibility"]["reason"], null>, string> = {
  CALL_NOT_COMPLETED: "Assessment is available after a completed call with a saved transcript.",
  NO_TRANSCRIPT: "This completed call has no saved transcript to assess.",
  TRANSCRIPT_TOO_LARGE: "This transcript is too large to assess without omitting part of the call."
};

export function assessmentView(response: CallAssessmentResponse, canAssess: boolean, now: Date): AssessmentView {
  const savedResult = response.assessment?.status === "SUCCEEDED" && response.assessment.result !== null;
  const staleDetail = response.current ? "" : " Transcript or recorded facts changed; the saved assessment is stale.";
  if (!response.capability.enabled || !response.capability.available) {
    const turnedOff = response.capability.reason === "DISABLED";
    return {
      kind: "unavailable", headline: turnedOff ? "Assessment is turned off" : "Assessment unavailable",
      detail: `${turnedOff ? "New assessments are turned off." : "Assessment configuration is incomplete."}${savedResult ? ` A saved advisory result remains available below.${staleDetail}` : ""}`,
      liveMessage: null, canRequest: false, actionLabel: null, shouldPoll: false, showResult: savedResult
    };
  }
  if (!response.eligibility.eligible) {
    return {
      kind: "ineligible", headline: "Assessment unavailable for this call", detail: `${ineligibleDetail[response.eligibility.reason ?? "CALL_NOT_COMPLETED"]}${savedResult && !response.current ? staleDetail : ""}`,
      liveMessage: null, canRequest: false, actionLabel: null, shouldPoll: false, showResult: savedResult
    };
  }

  const automatic = response.automaticJob;
  if (automatic && (automatic.state === "PENDING" || (automatic.state === "RUNNING" && !automatic.stalled))) {
    const running = automatic.state === "RUNNING";
    return {
      kind: "queued",
      headline: running ? "Automatic assessment running" : "Automatic assessment queued",
      detail: running ? "A post-call assessment is running for the saved transcript." : "A post-call assessment will run after final call details settle.",
      liveMessage: running ? "Automatic assessment running. Results will appear here." : "Automatic assessment queued. Results will appear here.",
      canRequest: canAssess,
      actionLabel: canAssess ? "Run assessment" : null,
      shouldPoll: true,
      showResult: savedResult
    };
  }
  if (automatic?.stalled) {
    return {
      kind: "interrupted", headline: "Automatic assessment was interrupted",
      detail: "The automatic assessment worker lease expired before a result was saved.",
      liveMessage: null, canRequest: canAssess, actionLabel: canAssess ? "Run assessment" : null,
      shouldPoll: false, showResult: savedResult
    };
  }
  if (automatic && (automatic.state === "FAILED" || automatic.state === "SKIPPED")) {
    return {
      kind: "failed", headline: "Automatic assessment was not completed",
      detail: automatic.state === "SKIPPED" ? "Automatic assessment was not queued because the queue was full." : "Automatic assessment needs attention before it can be retried.",
      liveMessage: null, canRequest: canAssess, actionLabel: canAssess ? "Run assessment" : null,
      shouldPoll: false, showResult: savedResult
    };
  }
  const assessment = response.assessment;
  if (!assessment) {
    return {
      kind: "ready", headline: "No assessment saved", detail: "Sends this saved transcript to TypeSafe AI for advisory assessment.",
      liveMessage: null, canRequest: canAssess, actionLabel: canAssess ? "Run assessment" : null, shouldPoll: false, showResult: false
    };
  }
  if (assessment.status === "RUNNING") {
    const leaseActive = assessment.leaseExpiresAt !== null && new Date(assessment.leaseExpiresAt).getTime() > now.getTime();
    if (leaseActive) {
      return {
        kind: "running", headline: "Assessment running", detail: "A supervisor requested an advisory assessment of the saved transcript.",
        liveMessage: "Assessment running. Results will appear here.", canRequest: false, actionLabel: null, shouldPoll: true, showResult: false
      };
    }
    return {
      kind: "interrupted", headline: "Assessment was interrupted", detail: "The assessment lease expired before a result was saved.",
      liveMessage: null, canRequest: canAssess, actionLabel: canAssess ? "Try assessment again" : null,
      shouldPoll: false, showResult: false
    };
  }
  if (assessment.status === "FAILED") {
    const cooldown = assessmentWakeDelay(response, now);
    return {
      kind: "failed", headline: "Assessment could not be completed", detail: assessment.retryable ? "No advisory result was saved. Review the transcript and try again if needed." : "No advisory result was saved. Retry will be available shortly.",
      liveMessage: null, canRequest: canAssess && assessment.retryable, actionLabel: canAssess && assessment.retryable ? "Try assessment again" : null,
      shouldPoll: cooldown !== null, showResult: false
    };
  }
  if (!response.current) {
    return {
      kind: "stale", headline: "Saved assessment is stale", detail: "Transcript or recorded facts changed; assess again before relying on this result.",
      liveMessage: null, canRequest: canAssess, actionLabel: canAssess ? "Assess again" : null, shouldPoll: false, showResult: assessment.result !== null
    };
  }
  return {
    kind: "succeeded", headline: "Assessment saved", detail: "Advisory AI assessment — review the transcript.",
    liveMessage: null, canRequest: canAssess, actionLabel: canAssess ? "Assess again" : null, shouldPoll: false, showResult: assessment.result !== null
  };
}

export function assessmentWakeDelay(response: CallAssessmentResponse, now: Date): number | null {
  const automatic = response.automaticJob;
  if (automatic && (automatic.state === "PENDING" || (automatic.state === "RUNNING" && !automatic.stalled))) {
    if (automatic.state === "RUNNING" && automatic.leaseExpiresAt && new Date(automatic.leaseExpiresAt).getTime() <= now.getTime()) return null;
    return POLL_INTERVAL_MS;
  }
  const assessment = response.assessment;
  if (!assessment) return null;
  if (assessment.status === "RUNNING") {
    if (assessment.leaseExpiresAt === null || new Date(assessment.leaseExpiresAt).getTime() <= now.getTime()) return null;
    return POLL_INTERVAL_MS;
  }
  if (assessment.status === "FAILED" && !assessment.retryable && assessment.completedAt !== null) {
    return Math.max(POLL_INTERVAL_MS, new Date(assessment.completedAt).getTime() + COOLDOWN_MS - now.getTime());
  }
  return null;
}

export function responseBelongsToCall(openCallId: string, requestCallId: string, response: CallAssessmentResponse): boolean {
  return openCallId === requestCallId && (response.assessment === null || response.assessment.callId === requestCallId);
}

export function savedCallAssessmentRevision(call: {
  status: string;
  endedAt: string | null;
  language: string | null;
  utterances: Array<{ id: string; seq: number; text: string }>;
  tickets: Array<{ id: string }>;
}): string {
  return JSON.stringify({
    status: call.status,
    endedAt: call.endedAt,
    language: call.language,
    utterances: call.utterances.map(({ id, seq, text }) => [id, seq, text]),
    ticketIds: call.tickets.map(({ id }) => id).sort()
  });
}
