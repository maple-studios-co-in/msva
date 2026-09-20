import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBusinessRequest, DemoRequestError } from "./demoRequests.js";

const execFileAsync = promisify(execFile);
const psql = "/opt/homebrew/opt/postgresql@17/bin/psql";
const databaseUrl = process.env.MSVA_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("MSVA_TEST_DATABASE_URL is required for PostgreSQL integration tests.");
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
    const [one, two] = await Promise.all([
      createBusinessRequest(db, command),
      createBusinessRequest(db, command)
    ]);

    expect(one).toEqual(two);
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
