export type CallAssessmentStatus = "RUNNING" | "SUCCEEDED" | "FAILED";

export type AssessmentChoice<T extends string> = {
  choice: T;
  probabilities: Record<T, number>;
  confidence: number;
};

export type CallAssessmentResult = {
  repetition: AssessmentChoice<"repetitive" | "not_repetitive" | "insufficient_context">;
  callerSentiment: AssessmentChoice<"positive" | "neutral" | "frustrated" | "unclear">;
  followUpNeed: AssessmentChoice<"indicated" | "not_indicated" | "unclear">;
  ticketCreationClaim: AssessmentChoice<"claimed" | "not_claimed" | "unclear">;
  journey: AssessmentChoice<"consumer_complaint" | "retailer_enquiry" | "distributor_support" | "sales_interest" | "unclear">;
  urgency: AssessmentChoice<"possible_safety" | "routine" | "unclear">;
  possibleUnsupportedTicketClaim: boolean;
  linkedTicketRecorded: boolean;
};

export type CallAssessmentDto = {
  id: string;
  callId: string;
  status: CallAssessmentStatus;
  requestedAt: string;
  completedAt: string | null;
  leaseExpiresAt: string | null;
  retryable: boolean;
  requestedModel: string;
  returnedModel: string | null;
  rubricVersion: string;
  inputHash: string;
  errorCode: string | null;
  result: CallAssessmentResult | null;
};

export type CallAssessmentCapability = {
  enabled: boolean;
  available: boolean;
  reason: "DISABLED" | "MISSING_API_KEY" | "MISSING_ALLOWED_ORIGINS" | null;
};

export type CallAssessmentEligibility = {
  eligible: boolean;
  reason: "CALL_NOT_COMPLETED" | "NO_TRANSCRIPT" | "TRANSCRIPT_TOO_LARGE" | null;
};

export type CallAssessmentResponse = {
  capability: CallAssessmentCapability;
  eligibility: CallAssessmentEligibility;
  assessment: CallAssessmentDto | null;
  current: boolean;
  automaticJob?: AutomaticAssessmentJobDto | null;
};

export type AutomaticAssessmentJobDto = {
  state: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  dueAt: string;
  attempts: number;
  reason: string | null;
  leaseExpiresAt: string | null;
  stalled: boolean;
};
