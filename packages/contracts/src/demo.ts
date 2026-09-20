import { z } from "zod";

const IdSchema = z.string().min(1).max(128);
const ShortTextSchema = z.string().min(1).max(200);
const LongTextSchema = z.string().min(1).max(4_000);
const TerritorySchema = z.string().min(1).max(100);

export const LanguageSchema = z.enum(["hi", "en", "hinglish"]);
export type Language = z.infer<typeof LanguageSchema>;

export const JourneyKindSchema = z.enum([
  "CONSUMER_COMPLAINT",
  "RETAILER_ENQUIRY",
  "DISTRIBUTOR_CASE",
  "SALES_LEAD"
]);
export type JourneyKind = z.infer<typeof JourneyKindSchema>;

export const TruthStateSchema = z.enum([
  "RECORDED",
  "CONNECTED",
  "FIXTURE",
  "UNAVAILABLE",
  "PENDING_STAFF"
]);
export type TruthState = z.infer<typeof TruthStateSchema>;

export const IdentityAssuranceSchema = z.enum(["UNVERIFIED", "VERIFIED", "DEMO_TRUSTED"]);
export type IdentityAssurance = z.infer<typeof IdentityAssuranceSchema>;

const QueueSchema = z.strictObject({
  territory: TerritorySchema,
  language: LanguageSchema
});

const ConsumerFieldsSchema = z.strictObject({
  product: ShortTextSchema,
  purchaseArea: ShortTextSchema,
  issueCategory: ShortTextSchema,
  description: LongTextSchema,
  productAvailable: z.boolean(),
  batch: ShortTextSchema.optional(),
  expiry: ShortTextSchema.optional()
});
const RetailerFieldsSchema = z.strictObject({
  shopName: ShortTextSchema,
  contactPerson: ShortTextSchema,
  productRequest: ShortTextSchema,
  quantityRequest: ShortTextSchema,
  requestedOutcome: LongTextSchema,
  deliveryPreference: ShortTextSchema.optional()
});
const DistributorFieldsSchema = z.strictObject({
  enquiryType: ShortTextSchema,
  description: LongTextSchema,
  requestedResolution: LongTextSchema,
  distributorCode: ShortTextSchema.optional(),
  referenceNumber: ShortTextSchema.optional(),
  affectedProducts: ShortTextSchema.optional()
});
const SalesFieldsSchema = z.strictObject({
  name: ShortTextSchema,
  contactPreference: ShortTextSchema,
  interest: LongTextSchema,
  organisation: ShortTextSchema.optional(),
  location: ShortTextSchema.optional()
});

type RequestBranchShape<
  TJourney extends z.ZodTypeAny,
  TConfirmation extends z.ZodTypeAny,
  TFields extends z.ZodTypeAny
> = {
  requestId: typeof IdSchema;
  callId: typeof IdSchema;
  journey: TJourney;
  callerConfirmation: TConfirmation;
  fields: TFields;
  queue: typeof QueueSchema;
};

function createRequestBranch<
  TJourney extends z.ZodTypeAny,
  TConfirmation extends z.ZodTypeAny,
  TFields extends z.ZodTypeAny
>(
  journey: TJourney,
  confirmation: TConfirmation,
  fields: TFields
): z.ZodObject<RequestBranchShape<TJourney, TConfirmation, TFields>>;
function createRequestBranch<
  TJourney extends z.ZodTypeAny,
  TConfirmation extends z.ZodTypeAny,
  TFields extends z.ZodTypeAny,
  TParentRequestId extends z.ZodTypeAny
>(
  journey: TJourney,
  confirmation: TConfirmation,
  fields: TFields,
  parentRequestId: TParentRequestId
): z.ZodObject<RequestBranchShape<TJourney, TConfirmation, TFields> & { parentRequestId: TParentRequestId }>;
function createRequestBranch<
  TJourney extends z.ZodTypeAny,
  TConfirmation extends z.ZodTypeAny,
  TFields extends z.ZodTypeAny
>(journey: TJourney, confirmation: TConfirmation, fields: TFields, parentRequestId?: z.ZodTypeAny) {
  const shape = {
    requestId: IdSchema,
    callId: IdSchema,
    journey,
    callerConfirmation: confirmation,
    fields,
    queue: QueueSchema
  } as const;
  return parentRequestId
    ? z.strictObject({ ...shape, parentRequestId })
    : z.strictObject(shape);
}

const CreateRequestBranches = [
  createRequestBranch(z.literal("CONSUMER_COMPLAINT"), z.literal("NEW"), ConsumerFieldsSchema),
  createRequestBranch(z.literal("CONSUMER_COMPLAINT"), z.literal("SEPARATE"), ConsumerFieldsSchema),
  createRequestBranch(z.literal("CONSUMER_COMPLAINT"), z.literal("FOLLOW_UP"), ConsumerFieldsSchema, IdSchema),
  createRequestBranch(z.literal("RETAILER_ENQUIRY"), z.literal("NEW"), RetailerFieldsSchema),
  createRequestBranch(z.literal("RETAILER_ENQUIRY"), z.literal("SEPARATE"), RetailerFieldsSchema),
  createRequestBranch(z.literal("RETAILER_ENQUIRY"), z.literal("FOLLOW_UP"), RetailerFieldsSchema, IdSchema),
  createRequestBranch(z.literal("DISTRIBUTOR_CASE"), z.literal("NEW"), DistributorFieldsSchema),
  createRequestBranch(z.literal("DISTRIBUTOR_CASE"), z.literal("SEPARATE"), DistributorFieldsSchema),
  createRequestBranch(z.literal("DISTRIBUTOR_CASE"), z.literal("FOLLOW_UP"), DistributorFieldsSchema, IdSchema),
  createRequestBranch(z.literal("SALES_LEAD"), z.literal("NEW"), SalesFieldsSchema),
  createRequestBranch(z.literal("SALES_LEAD"), z.literal("SEPARATE"), SalesFieldsSchema),
  createRequestBranch(z.literal("SALES_LEAD"), z.literal("FOLLOW_UP"), SalesFieldsSchema, IdSchema)
] as const;

export const CreateRequestInputSchema = z.union(CreateRequestBranches);
export type CreateRequestInput = z.infer<typeof CreateRequestInputSchema>;

export const CreateRequestResultSchema = z.strictObject({
  requestId: IdSchema,
  callId: IdSchema,
  caseId: IdSchema,
  ticketNumber: z.number().int().positive(),
  truthState: z.literal("RECORDED"),
  actionState: z.enum(["RECORDED", "PENDING_STAFF"]),
  evidenceState: z.literal("NOT_REQUESTED")
});
export type CreateRequestResult = z.infer<typeof CreateRequestResultSchema>;

export const DemoErrorSchema = z.strictObject({
  code: z.enum([
    "INVALID_REQUEST",
    "CALL_NOT_FOUND",
    "IDENTITY_REQUIRED",
    "PARENT_NOT_ACCESSIBLE",
    "IDEMPOTENCY_CONFLICT",
    "TEMPORARILY_UNAVAILABLE"
  ]),
  message: LongTextSchema
});
export type DemoError = z.infer<typeof DemoErrorSchema>;

const CallerContextFollowUpSchema = z.strictObject({
  confirmation: z.literal("FOLLOW_UP"),
  parentRequestId: IdSchema
});
const CallerContextOtherSchema = z.strictObject({
  confirmation: z.enum(["NONE", "NEW", "SEPARATE"])
});
export const CallerContextInputSchema = z.union([
  CallerContextFollowUpSchema,
  CallerContextOtherSchema
]);
export type CallerContextInput = z.infer<typeof CallerContextInputSchema>;

const PriorRequestSchema = z.strictObject({
  id: IdSchema,
  journey: JourneyKindSchema,
  truthState: z.literal("RECORDED"),
  summary: LongTextSchema
});
const CallerContextBase = {
  callId: IdSchema,
  language: LanguageSchema,
  territory: TerritorySchema.optional()
};
const CallerContextEmptySchema = z.strictObject({
  ...CallerContextBase,
  identityAssurance: z.literal("UNVERIFIED"),
  match: z.enum(["NEW", "RETURNING_UNCONFIRMED", "UNCERTAIN"]),
  priorRequests: z.array(PriorRequestSchema).length(0)
});
const CallerContextNotConfirmedSchema = z.strictObject({
  ...CallerContextBase,
  identityAssurance: z.enum(["VERIFIED", "DEMO_TRUSTED"]),
  match: z.enum(["NEW", "RETURNING_UNCONFIRMED", "UNCERTAIN"]),
  priorRequests: z.array(PriorRequestSchema).length(0),
  callerId: IdSchema.optional()
});
const CallerContextConfirmedSchema = z.strictObject({
  ...CallerContextBase,
  identityAssurance: z.enum(["VERIFIED", "DEMO_TRUSTED"]),
  match: z.literal("RETURNING_CONFIRMED"),
  priorRequests: z.array(PriorRequestSchema).min(1).max(50),
  callerId: IdSchema.optional()
});
export const CallerContextSchema = z.union([
  CallerContextEmptySchema,
  CallerContextNotConfirmedSchema,
  CallerContextConfirmedSchema
]);
export type CallerContext = z.infer<typeof CallerContextSchema>;

const SourceDataSchema = z.strictObject({
  reference: ShortTextSchema,
  status: ShortTextSchema,
  items: z.array(ShortTextSchema).max(50)
});
export const SourceResultSchema = z.union([
  z.strictObject({
    truthState: z.literal("CONNECTED"),
    sourceRef: IdSchema,
    data: SourceDataSchema
  }),
  z.strictObject({
    truthState: z.literal("FIXTURE"),
    fixtureRef: IdSchema,
    data: SourceDataSchema
  }),
  z.strictObject({
    truthState: z.literal("UNAVAILABLE"),
    reason: LongTextSchema
  })
]);
export type SourceResult = z.infer<typeof SourceResultSchema>;

const DateTimeSchema = z.iso.datetime().regex(/^(?!0000-)/);

export const EvidenceSchema = z.union([
  z.strictObject({ state: z.literal("NOT_REQUESTED"), truthState: z.literal("RECORDED") }),
  z.strictObject({ state: z.literal("REQUESTED"), truthState: z.literal("RECORDED") }),
  z.strictObject({ state: z.literal("UNAVAILABLE"), truthState: z.literal("UNAVAILABLE") }),
  z.strictObject({ state: z.literal("REQUESTED"), truthState: z.literal("FIXTURE"), fixtureRef: IdSchema }),
  z.strictObject({
    state: z.literal("RECEIVED"),
    truthState: z.literal("RECORDED"),
    storageKey: IdSchema,
    receivedAt: DateTimeSchema
  })
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

const HandoffBase = {
  id: IdSchema,
  callId: IdSchema,
  version: z.number().int().positive()
};
export const HandoffSchema = z.union([
  z.strictObject({ ...HandoffBase, state: z.enum(["REQUESTED", "FAILED", "TIMED_OUT"]) }),
  z.strictObject({
    ...HandoffBase,
    state: z.enum(["ASSIGNED", "JOINING"]),
    assignedUserId: IdSchema
  }),
  z.strictObject({
    ...HandoffBase,
    state: z.literal("HUMAN_ACTIVE"),
    assignedUserId: IdSchema,
    activatedAt: DateTimeSchema
  })
]);
export type Handoff = z.infer<typeof HandoffSchema>;

export const RiskAssessmentSchema = z.strictObject({
  id: IdSchema,
  callId: IdSchema,
  sentiment: z.enum(["NEUTRAL", "POSITIVE", "NEGATIVE", "UNKNOWN"]),
  urgency: z.enum(["ROUTINE", "POSSIBLE_SAFETY", "UNKNOWN"]),
  mode: z.literal("SHADOW"),
  source: z.enum(["FIXTURE", "DETECTOR"]),
  rationale: LongTextSchema
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const DemoSchemas = {
  Language: LanguageSchema,
  JourneyKind: JourneyKindSchema,
  TruthState: TruthStateSchema,
  IdentityAssurance: IdentityAssuranceSchema,
  CreateRequestInput: CreateRequestInputSchema,
  CreateRequestResult: CreateRequestResultSchema,
  DemoError: DemoErrorSchema,
  CallerContextInput: CallerContextInputSchema,
  CallerContext: CallerContextSchema,
  SourceResult: SourceResultSchema,
  Evidence: EvidenceSchema,
  Handoff: HandoffSchema,
  RiskAssessment: RiskAssessmentSchema
} as const;
