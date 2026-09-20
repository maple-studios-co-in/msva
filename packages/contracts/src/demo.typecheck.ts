import type { CreateRequestInput } from "./demo.js";

const validFollowUp: CreateRequestInput = {
  requestId: "request-001",
  callId: "call-001",
  journey: "SALES_LEAD",
  callerConfirmation: "FOLLOW_UP",
  parentRequestId: "parent-001",
  fields: { name: "Meera", contactPreference: "email", interest: "Wholesale products" },
  queue: { territory: "Gujarat", language: "en" }
};

if (validFollowUp.callerConfirmation === "FOLLOW_UP") {
  const parentRequestId: string = validFollowUp.parentRequestId;
  void parentRequestId;
}

// @ts-expect-error FOLLOW_UP must identify the confirmed parent request.
const missingFollowUpParent: CreateRequestInput = {
  requestId: "request-002",
  callId: "call-002",
  journey: "SALES_LEAD",
  callerConfirmation: "FOLLOW_UP",
  fields: { name: "Meera", contactPreference: "email", interest: "Wholesale products" },
  queue: { territory: "Gujarat", language: "en" }
};
void missingFollowUpParent;

const invalidFollowUpParentType: CreateRequestInput = {
  requestId: "request-003",
  callId: "call-003",
  journey: "SALES_LEAD",
  callerConfirmation: "FOLLOW_UP",
  // @ts-expect-error parentRequestId must be a string.
  parentRequestId: 123,
  fields: { name: "Meera", contactPreference: "email", interest: "Wholesale products" },
  queue: { territory: "Gujarat", language: "en" }
};
void invalidFollowUpParentType;

const newRequestWithForbiddenParent: CreateRequestInput = {
  requestId: "request-004",
  callId: "call-004",
  journey: "SALES_LEAD",
  callerConfirmation: "NEW",
  // @ts-expect-error NEW must not link a prior request.
  parentRequestId: "parent-001",
  fields: { name: "Meera", contactPreference: "email", interest: "Wholesale products" },
  queue: { territory: "Gujarat", language: "en" }
};
void newRequestWithForbiddenParent;

const separateRequestWithForbiddenParent: CreateRequestInput = {
  requestId: "request-005",
  callId: "call-005",
  journey: "SALES_LEAD",
  callerConfirmation: "SEPARATE",
  // @ts-expect-error SEPARATE must not link a prior request.
  parentRequestId: "parent-001",
  fields: { name: "Meera", contactPreference: "email", interest: "Wholesale products" },
  queue: { territory: "Gujarat", language: "en" }
};
void separateRequestWithForbiddenParent;
