import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  CreateRequestInputSchema,
  type CreateRequestInput,
  type CreateRequestResult
} from "@msva/contracts";

type DemoRequestErrorCode =
  | "INVALID_REQUEST"
  | "CALL_NOT_FOUND"
  | "IDENTITY_REQUIRED"
  | "PARENT_NOT_ACCESSIBLE"
  | "IDEMPOTENCY_CONFLICT"
  | "TEMPORARILY_UNAVAILABLE";

export class DemoRequestError extends Error {
  constructor(
    readonly code: DemoRequestErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DemoRequestError";
  }
}

export type TrustedDemoRequestConfig = {
  /** Server-owned allowlist. Browser isTest alone is never sufficient. */
  isDemoFixtureAllowed?: (callerId: string, fixtureKey: string) => boolean;
  /** Test-only transaction fault injection; never derived from a caller request. */
  afterTicketOrNotePersistedForTest?: () => void | Promise<void>;
  /** Test-only evidence that recovery happened after PostgreSQL rejected a duplicate key. */
  onUniqueRequestIdRaceRecoveredForTest?: () => void | Promise<void>;
};

type ReplayRecord = {
  callId: string;
  payloadCanonical: string;
  result: Prisma.JsonValue;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function summaryFor(input: CreateRequestInput): string {
  const fields = input.fields as Record<string, unknown>;
  const detail =
    (typeof fields.description === "string" && fields.description) ||
    (typeof fields.requestedOutcome === "string" && fields.requestedOutcome) ||
    (typeof fields.interest === "string" && fields.interest) ||
    (typeof fields.productRequest === "string" && fields.productRequest) ||
    "Request recorded";
  return `${input.journey}: ${detail}`;
}

function followUpParentId(input: CreateRequestInput): string | undefined {
  return "parentRequestId" in input && typeof input.parentRequestId === "string"
    ? input.parentRequestId
    : undefined;
}

function idempotencyConflict(): DemoRequestError {
  return new DemoRequestError("IDEMPOTENCY_CONFLICT", "This request ID was already used for a different command.");
}

function replayOrConflict(
  record: ReplayRecord | null,
  input: CreateRequestInput,
  payloadCanonical: string
): CreateRequestResult | undefined {
  if (!record) return undefined;
  if (record.callId !== input.callId || record.payloadCanonical !== payloadCanonical) throw idempotencyConflict();
  if (record.result === null || Array.isArray(record.result) || typeof record.result !== "object") {
    throw new DemoRequestError("TEMPORARILY_UNAVAILABLE", "The saved request receipt is unavailable.");
  }
  return record.result as unknown as CreateRequestResult;
}

function isRequestIdUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = error.meta?.target;
  return (
    (Array.isArray(target) && target.some((value) => String(value).includes("requestId"))) ||
    (typeof target === "string" && target.includes("requestId"))
  );
}

async function recoverRace(
  db: PrismaClient,
  input: CreateRequestInput,
  payloadCanonical: string
): Promise<CreateRequestResult | undefined> {
  const record = await db.businessRequest.findUnique({
    where: { requestId: input.requestId },
    select: { callId: true, payloadCanonical: true, result: true }
  });
  return replayOrConflict(record, input, payloadCanonical);
}

export async function createBusinessRequest(
  db: PrismaClient,
  untrustedInput: unknown,
  trustedConfig: TrustedDemoRequestConfig = {}
): Promise<CreateRequestResult> {
  const parsed = CreateRequestInputSchema.safeParse(untrustedInput);
  if (!parsed.success) {
    throw new DemoRequestError("INVALID_REQUEST", "The request does not match the supported journey contract.");
  }

  const input = parsed.data;
  const payloadCanonical = stableJson(input);
  const payloadHash = createHash("sha256").update(payloadCanonical).digest("hex");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const call = await tx.call.findUnique({
          where: { id: input.callId },
          select: {
            id: true,
            provider: true,
            isTest: true,
            callerId: true,
            fromNumber: true,
            callerName: true
          }
        });
        if (!call) throw new DemoRequestError("CALL_NOT_FOUND", "The call is no longer available.");

        const existing = await tx.businessRequest.findUnique({
          where: { requestId: input.requestId },
          select: { callId: true, payloadCanonical: true, result: true }
        });
        const replay = replayOrConflict(existing, input, payloadCanonical);
        if (replay) return replay;

        const identity = await tx.demoCallIdentity.findUnique({
          where: { callId: call.id },
          select: { callerId: true, assurance: true, verifiedAt: true, verificationRef: true, fixtureKey: true }
        });
        if (identity && identity.callerId !== call.callerId) {
          throw new DemoRequestError("IDENTITY_REQUIRED", "The caller identity could not be confirmed.");
        }

        const verified =
          identity?.assurance === "VERIFIED" &&
          identity.callerId !== null &&
          identity.verifiedAt !== null &&
          identity.verificationRef !== null &&
          identity.fixtureKey === null;
        const demoTrusted =
          identity?.assurance === "DEMO_TRUSTED" &&
          call.provider === "BROWSER" &&
          call.isTest &&
          identity.callerId !== null &&
          identity.verifiedAt !== null &&
          identity.verificationRef === null &&
          identity.fixtureKey !== null &&
          trustedConfig.isDemoFixtureAllowed?.(identity.callerId, identity.fixtureKey) === true;
        const trustedCallerId = verified || demoTrusted ? identity!.callerId : null;
        const effectiveVerificationState = verified
          ? "VERIFIED"
          : demoTrusted
            ? "DEMO_TRUSTED"
            : "UNVERIFIED";

        let ticketId: string;
        let ticketNumber: number;
        const parentRequestId = followUpParentId(input);
        if (input.callerConfirmation === "FOLLOW_UP") {
          if (!trustedCallerId || !parentRequestId) {
            throw new DemoRequestError("PARENT_NOT_ACCESSIBLE", "The earlier request is not accessible for this call.");
          }
          const parent = await tx.businessRequest.findUnique({
            where: { id: parentRequestId },
            include: { ticket: { select: { id: true, callerId: true, number: true } }, call: { select: { isTest: true } } }
          });
          if (
            !parent ||
            parent.callerId !== trustedCallerId ||
            parent.ticket.callerId !== trustedCallerId ||
            parent.journey !== input.journey ||
            parent.call.isTest !== call.isTest
          ) {
            throw new DemoRequestError("PARENT_NOT_ACCESSIBLE", "The earlier request is not accessible for this call.");
          }
          ticketId = parent.ticket.id;
          ticketNumber = parent.ticket.number;
          await tx.ticketNote.create({ data: { ticketId, text: summaryFor(input) } });
        } else {
          const ticket = await tx.ticket.create({
            data: {
              callId: call.id,
              callerId: call.callerId,
              phone: call.fromNumber,
              callerName: call.callerName ?? undefined,
              intent: input.journey,
              summary: summaryFor(input),
              details: input.fields as Prisma.InputJsonValue
            },
            select: { id: true, number: true }
          });
          ticketId = ticket.id;
          ticketNumber = ticket.number;
        }

        await trustedConfig.afterTicketOrNotePersistedForTest?.();

        const request = await tx.businessRequest.create({
          data: {
            requestId: input.requestId,
            callId: call.id,
            callerId: call.callerId,
            ticketId,
            journey: input.journey,
            callerConfirmation: input.callerConfirmation,
            parentRequestId,
            language: input.queue.language,
            territory: input.queue.territory,
            verificationState: effectiveVerificationState,
            fields: input.fields as Prisma.InputJsonValue,
            payloadCanonical,
            payloadHash,
            result: Prisma.JsonNull
          },
          select: { id: true }
        });
        await tx.queueAssignment.create({
          data: {
            businessRequestId: request.id,
            territory: input.queue.territory,
            language: input.queue.language
          }
        });
        await tx.auditLog.create({
          data: {
            action: "demo_request_recorded",
            entity: "BusinessRequest",
            entityId: request.id,
            meta: { requestId: input.requestId, journey: input.journey, ticketId }
          }
        });

        const receipt: CreateRequestResult = {
          requestId: input.requestId,
          callId: call.id,
          caseId: ticketId,
          ticketNumber,
          truthState: "RECORDED",
          actionState: "PENDING_STAFF",
          evidenceState: "NOT_REQUESTED"
        };
        await tx.businessRequest.update({
          where: { id: request.id },
          data: { result: receipt as Prisma.InputJsonValue }
        });
        return receipt;
      });
    } catch (error) {
      if (!isRequestIdUniqueViolation(error)) throw error;
      const replay = await recoverRace(db, input, payloadCanonical);
      if (replay) {
        await trustedConfig.onUniqueRequestIdRaceRecoveredForTest?.();
        return replay;
      }
    }
  }

  throw new DemoRequestError("TEMPORARILY_UNAVAILABLE", "The request could not be recorded safely. Please retry.");
}
