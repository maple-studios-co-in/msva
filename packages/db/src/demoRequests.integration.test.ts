import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBusinessRequest, DemoRequestError } from "./demoRequests.js";

const execFileAsync = promisify(execFile);
const psql = process.env.PSQL_BIN ?? "psql";
const databaseUrl = process.env.MSVA_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("MSVA_TEST_DATABASE_URL is required for PostgreSQL integration tests.");
}
if (new URL(databaseUrl).searchParams.get("application_name") !== "msva-foundation-integration") {
  throw new Error("MSVA_TEST_DATABASE_URL must use application_name=msva-foundation-integration.");
}

const initMigration = new URL("../prisma/migrations/20260905140843_init/migration.sql", import.meta.url);
const demoMigration = new URL("../prisma/migrations/20260921000000_demo_journeys/migration.sql", import.meta.url);

let schema: string;
let db: PrismaClient;

function schemaUrl(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("schema", name);
  return parsed.toString();
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: `request-${randomUUID()}`,
    callId: "call-a",
    journey: "CONSUMER_COMPLAINT",
    callerConfirmation: "NEW",
    fields: {
      product: "Oil",
      purchaseArea: "Indore",
      issueCategory: "quality",
      description: "Package was damaged",
      productAvailable: true
    },
    queue: { territory: "MP", language: "hi" },
    ...overrides
  };
}

async function psqlRun(args: string[], useSchema = true): Promise<void> {
  await execFileAsync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl!, ...args], {
    env: useSchema ? { ...process.env, PGOPTIONS: `-c search_path=${schema},public` } : process.env
  });
}

async function createCall(
  id: string,
  options: { callerId?: string | null; isTest?: boolean; provider?: "BROWSER" | "EXOTEL" } = {}
): Promise<void> {
  await db.call.create({
    data: {
      id,
      provider: options.provider ?? "BROWSER",
      isTest: options.isTest ?? true,
      callerId: options.callerId ?? "caller-a",
      fromNumber: "+919999999999"
    }
  });
}

async function attest(callId: string, callerId = "caller-a"): Promise<void> {
  await db.demoCallIdentity.create({
    data: {
      callId,
      callerId,
      assurance: "VERIFIED",
      verifiedAt: new Date("2026-09-21T00:00:00.000Z"),
      verificationRef: "server-attestation"
    }
  });
}

async function demoAttest(
  callId: string,
  options: { callerId?: string; fixtureKey?: string } = {}
): Promise<void> {
  await db.demoCallIdentity.create({
    data: {
      callId,
      callerId: options.callerId ?? "caller-a",
      assurance: "DEMO_TRUSTED",
      verifiedAt: new Date("2026-09-21T00:00:00.000Z"),
      fixtureKey: options.fixtureKey ?? "fixture-allowed"
    }
  });
}

beforeEach(async () => {
  schema = `msva_foundation_request_${randomUUID().replaceAll("-", "")}`;
  await psqlRun(["-c", `CREATE SCHEMA ${schema}`], false);
  await psqlRun(["-f", initMigration.pathname]);
  await psqlRun(["-f", demoMigration.pathname]);
  db = new PrismaClient({ datasourceUrl: schemaUrl(databaseUrl!, schema) });
  await db.caller.create({ data: { id: "caller-a", phone: "+919999999999" } });
  await db.caller.create({ data: { id: "caller-b", phone: "+918888888888" } });
  await createCall("call-a");
});

afterEach(async () => {
  await db?.$disconnect();
  await psqlRun(["-c", `DROP SCHEMA IF EXISTS ${schema} CASCADE`], false);
});

describe("createBusinessRequest", () => {
  it("replays an equal request without duplicate records or a Call outcome write", async () => {
    const command = input();
    const first = await createBusinessRequest(db, command);
    const second = await createBusinessRequest(db, command);

    expect(second).toEqual(first);
    expect(await db.businessRequest.count()).toBe(1);
    expect(await db.ticket.count()).toBe(1);
    expect(await db.queueAssignment.count()).toBe(1);
    expect(await db.auditLog.count()).toBe(1);
    expect((await db.call.findUniqueOrThrow({ where: { id: "call-a" } })).outcome).toBe("IN_PROGRESS");
  });

  it("recovers an equal concurrent retry after the unique-key race", async () => {
    const command = input();
    let releaseFirst: (() => void) | undefined;
    let firstTicketWritten: (() => void) | undefined;
    const firstTicket = new Promise<void>((resolve) => {
      firstTicketWritten = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let recovered = 0;
    const first = createBusinessRequest(db, command, {
      afterTicketOrNotePersistedForTest: async () => {
        firstTicketWritten?.();
        await release;
      },
      onUniqueRequestIdRaceRecoveredForTest: () => {
        recovered += 1;
      }
    });
    await firstTicket;
    const second = createBusinessRequest(db, command);
    const two = await second;
    releaseFirst?.();
    const one = await first;

    expect(one).toEqual(two);
    expect(recovered).toBe(1);
    expect(await db.businessRequest.count()).toBe(1);
    expect(await db.ticket.count()).toBe(1);
    expect(await db.queueAssignment.count()).toBe(1);
    expect(await db.auditLog.count()).toBe(1);
  });

  it("rejects a concurrent conflicting retry without exposing the winning request", async () => {
    const requestId = `request-${randomUUID()}`;
    const winner = input({ requestId });
    const conflict = input({
      requestId,
      fields: {
        product: "Oil",
        purchaseArea: "Indore",
        issueCategory: "quality",
        description: "A different description",
        productAvailable: true
      }
    });

    const settled = await Promise.allSettled([
      createBusinessRequest(db, winner),
      createBusinessRequest(db, conflict)
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await db.businessRequest.count()).toBe(1);
  });

  it("rolls back a ticket created before a later transaction failure", async () => {
    await expect(
      createBusinessRequest(db, input(), {
        afterTicketOrNotePersistedForTest: () => {
          throw new Error("forced rollback");
        }
      })
    ).rejects.toThrow("forced rollback");
    expect(await db.ticket.count()).toBe(0);
    expect(await db.businessRequest.count()).toBe(0);
    expect(await db.queueAssignment.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });

  it("treats every accepted command field as part of the idempotency receipt", async () => {
    const requestId = `request-${randomUUID()}`;
    await createBusinessRequest(db, input({ requestId }));
    await createCall("call-b");
    const variants = [
      input({ requestId, callId: "call-b" }),
      input({ requestId, queue: { territory: "RJ", language: "hi" } }),
      input({ requestId, callerConfirmation: "FOLLOW_UP", parentRequestId: "other-request" }),
      input({
        requestId,
        fields: {
          product: "Oil",
          purchaseArea: "Indore",
          issueCategory: "quality",
          description: "Changed",
          productAvailable: true
        }
      })
    ];
    for (const variant of variants) {
      await expect(createBusinessRequest(db, variant)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    }
    expect(await db.businessRequest.count()).toBe(1);
  });

  it("rejects a missing call without recording a request", async () => {
    await expect(createBusinessRequest(db, input({ callId: "missing-call" }))).rejects.toMatchObject({
      code: "CALL_NOT_FOUND"
    } satisfies Partial<DemoRequestError>);
    expect(await db.businessRequest.count()).toBe(0);
  });

  it("denies an unverified follow-up even when the caller matches", async () => {
    const original = await createBusinessRequest(db, input());
    await createCall("call-follow-up");
    await expect(
      createBusinessRequest(
        db,
        input({
          callId: "call-follow-up",
          callerConfirmation: "FOLLOW_UP",
          parentRequestId: (await db.businessRequest.findFirstOrThrow()).id
        })
      )
    ).rejects.toMatchObject({ code: "PARENT_NOT_ACCESSIBLE" });
    expect(original.caseId).toBeTruthy();
    expect(await db.ticketNote.count()).toBe(0);
  });

  it("adds one note to a trusted same-matter follow-up and keeps its ticket", async () => {
    const original = await createBusinessRequest(db, input());
    const parent = await db.businessRequest.findFirstOrThrow();
    await createCall("call-follow-up");
    await attest("call-follow-up");

    const followUp = await createBusinessRequest(
      db,
      input({
        callId: "call-follow-up",
        callerConfirmation: "FOLLOW_UP",
        parentRequestId: parent.id
      })
    );
    expect(followUp.caseId).toBe(original.caseId);
    expect(await db.ticket.count()).toBe(1);
    expect(await db.ticketNote.count()).toBe(1);
    expect((await db.businessRequest.count())).toBe(2);
  });

  it("accepts an immediately created parent even when its database timestamp is in the future", async () => {
    await createBusinessRequest(db, input());
    const parent = await db.businessRequest.findFirstOrThrow();
    await db.businessRequest.update({
      where: { id: parent.id },
      data: { createdAt: new Date("2099-01-01T00:00:00.000Z") }
    });
    await createCall("call-follow-up");
    await attest("call-follow-up");
    const followUp = await createBusinessRequest(
      db,
      input({ callId: "call-follow-up", callerConfirmation: "FOLLOW_UP", parentRequestId: parent.id })
    );
    expect(followUp.caseId).toBe(parent.ticketId);
    expect(await db.ticketNote.count()).toBe(1);
  });

  it("rolls back a follow-up note if the transaction fails after it is written", async () => {
    await createBusinessRequest(db, input());
    const parent = await db.businessRequest.findFirstOrThrow();
    await createCall("call-follow-up");
    await attest("call-follow-up");
    await expect(
      createBusinessRequest(
        db,
        input({ callId: "call-follow-up", callerConfirmation: "FOLLOW_UP", parentRequestId: parent.id }),
        { afterTicketOrNotePersistedForTest: () => { throw new Error("forced note rollback"); } }
      )
    ).rejects.toThrow("forced note rollback");
    expect(await db.ticketNote.count()).toBe(0);
    expect(await db.businessRequest.count()).toBe(1);
  });

  it("denies cross-caller, cross-journey, and demo-to-real follow-up links", async () => {
    await createBusinessRequest(db, input());
    const parent = await db.businessRequest.findFirstOrThrow();
    await attest("call-a");
    await createCall("call-other-caller", { callerId: "caller-b" });
    await attest("call-other-caller", "caller-b");
    await createCall("call-real", { isTest: false });
    await attest("call-real");
    const attempts = [
      input({ callId: "call-other-caller", callerConfirmation: "FOLLOW_UP", parentRequestId: parent.id }),
      input({ callId: "call-real", callerConfirmation: "FOLLOW_UP", parentRequestId: parent.id }),
      input({
        callId: "call-a",
        journey: "SALES_LEAD",
        callerConfirmation: "FOLLOW_UP",
        parentRequestId: parent.id,
        fields: { name: "A", contactPreference: "phone", interest: "oil" }
      })
    ];
    for (const attempt of attempts) {
      await expect(createBusinessRequest(db, attempt)).rejects.toMatchObject({ code: "PARENT_NOT_ACCESSIBLE" });
    }
    expect(await db.ticketNote.count()).toBe(0);
  });

  it("stores only an effective validated assurance snapshot", async () => {
    await createCall("call-missing-allowlist");
    await demoAttest("call-missing-allowlist");
    await createBusinessRequest(db, input({ callId: "call-missing-allowlist" }));
    expect((await db.businessRequest.findFirstOrThrow({ where: { callId: "call-missing-allowlist" } })).verificationState).toBe("UNVERIFIED");

    await createCall("call-carrier", { provider: "EXOTEL" });
    await demoAttest("call-carrier");
    await createBusinessRequest(db, input({ callId: "call-carrier" }), { isDemoFixtureAllowed: () => true });
    expect((await db.businessRequest.findFirstOrThrow({ where: { callId: "call-carrier" } })).verificationState).toBe("UNVERIFIED");

    await createCall("call-allowed");
    await demoAttest("call-allowed");
    await createBusinessRequest(db, input({ callId: "call-allowed" }), {
      isDemoFixtureAllowed: (callerId, fixtureKey) => callerId === "caller-a" && fixtureKey === "fixture-allowed"
    });
    expect((await db.businessRequest.findFirstOrThrow({ where: { callId: "call-allowed" } })).verificationState).toBe("DEMO_TRUSTED");
  });

  it("rejects an identity attestation that does not match the Call caller", async () => {
    await createCall("call-mismatch");
    await demoAttest("call-mismatch", { callerId: "caller-b" });
    await expect(createBusinessRequest(db, input({ callId: "call-mismatch" }))).rejects.toMatchObject({
      code: "IDENTITY_REQUIRED"
    });
    expect(await db.businessRequest.count()).toBe(0);
  });

  it("creates a new ticket for a separate case and does not append a note", async () => {
    await createBusinessRequest(db, input());
    const result = await createBusinessRequest(db, input({ callerConfirmation: "SEPARATE" }));
    expect(result.caseId).toBeTruthy();
    expect(await db.ticket.count()).toBe(2);
    expect(await db.ticketNote.count()).toBe(0);
  });

  it("keeps callback records passive and lets PostgreSQL enforce evidence, handoff, and foreign keys", async () => {
    await createBusinessRequest(db, input());
    const request = await db.businessRequest.findFirstOrThrow();
    const callCount = await db.call.count();
    await db.callbackRequest.create({ data: { businessRequestId: request.id } });
    expect(await db.call.count()).toBe(callCount);
    expect((await db.callbackRequest.findFirstOrThrow()).state).toBe("PENDING_STAFF");

    await expect(
      db.evidenceAttachment.create({
        data: { ticketId: request.ticketId, state: "RECEIVED", provenance: "FIXTURE", fixtureRef: "photo-1" }
      })
    ).rejects.toThrow();
    await db.handoff.create({ data: { callId: "call-a", state: "REQUESTED" } });
    await expect(db.handoff.create({ data: { callId: "call-a", state: "REQUESTED" } })).rejects.toThrow();
    await expect(
      db.riskAssessment.create({
        data: { callId: "missing-call", sentiment: "UNKNOWN", urgency: "UNKNOWN", source: "FIXTURE", rationale: "fixture" }
      })
    ).rejects.toThrow();
  });
});
