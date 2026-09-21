import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@msva/db";
import { recordCallEnd } from "./calls.js";
import { runAssessmentTick } from "./assessmentJobs.js";

const databaseUrl = process.env.JEV_TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("/msva_jev_test") || process.env.DATABASE_URL !== databaseUrl) {
  throw new Error("DATABASE_URL and JEV_TEST_DATABASE_URL must both point to the disposable msva_jev_test database.");
}

const db = new PrismaClient({ datasourceUrl: databaseUrl });
const callIds: string[] = [];

const choice = <T extends string>(value: T, values: readonly T[]) => ({
  type: "choice", choice: value, probabilities: Object.fromEntries(values.map((item) => [item, item === value ? 1 : 0])), confidence: 1
});

function providerPayload() {
  return { model: "jev-1.13.0", answers: {
    repetition: choice("not_repetitive", ["repetitive", "not_repetitive", "insufficient_context"]),
    callerSentiment: choice("neutral", ["positive", "neutral", "frustrated", "unclear"]),
    followUpNeed: choice("not_indicated", ["indicated", "not_indicated", "unclear"]),
    ticketCreationClaim: choice("not_claimed", ["claimed", "not_claimed", "unclear"]),
    journey: choice("retailer_enquiry", ["consumer_complaint", "retailer_enquiry", "distributor_support", "sales_interest", "unclear"]),
    urgency: choice("routine", ["possible_safety", "routine", "unclear"])
  } };
}

beforeEach(() => {
  vi.stubEnv("JEV_ENABLED", "true");
  vi.stubEnv("JEV_API_KEY", "test-key");
  vi.stubEnv("JEV_ALLOWED_ORIGINS", "https://console.test");
  vi.stubEnv("JEV_AUTO_POST_CALL_ENABLED", "true");
  vi.stubEnv("JEV_AUTO_START_AT", "2020-01-01T00:00:00.000Z");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.assessmentJob.deleteMany({ where: { callId: { in: callIds } } });
  await db.callAssessment.deleteMany({ where: { callId: { in: callIds } } });
  await db.call.deleteMany({ where: { id: { in: callIds } } });
  callIds.splice(0);
});
afterAll(async () => {
  await db.assessmentJob.deleteMany({ where: { callId: { in: callIds } } });
  await db.callAssessment.deleteMany({ where: { callId: { in: callIds } } });
  await db.call.deleteMany({ where: { id: { in: callIds } } });
  await db.$disconnect();
});

async function openCall() {
  const id = `auto-assessment-${randomUUID()}`;
  callIds.push(id);
  await db.call.create({ data: {
    id, provider: "BROWSER", isTest: true, fromNumber: "browser", status: "IN_PROGRESS", outcome: "IN_PROGRESS",
    utterances: { create: { seq: 1, speaker: "CALLER", text: "Please call me tomorrow." } }
  } });
  return id;
}

describe("automatic post-call queue", () => {
  it("commits the completed call and durable job before any provider work", async () => {
    const callId = await openCall();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await recordCallEnd(callId, {});

    expect(await db.call.findUniqueOrThrow({ where: { id: callId }, select: { status: true, endedAt: true } })).toMatchObject({ status: "COMPLETED", endedAt: expect.any(Date) });
    expect(await db.assessmentJob.findUniqueOrThrow({ where: { callId_kind: { callId, kind: "POST_CALL" } } })).toMatchObject({ state: "PENDING", attempts: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps duplicate completion to one queued logical assessment", async () => {
    const callId = await openCall();

    await recordCallEnd(callId, {});
    await recordCallEnd(callId, {});

    expect(await db.assessmentJob.count({ where: { callId, kind: "POST_CALL" } })).toBe(1);
  });

  it("does not queue or call a provider when automatic mode is disabled", async () => {
    const callId = await openCall();
    vi.stubEnv("JEV_AUTO_POST_CALL_ENABLED", "false");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await recordCallEnd(callId, {});
    await runAssessmentTick(new Date(Date.now() + 6_000));

    expect(await db.assessmentJob.count({ where: { callId } })).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the durable worker after settling and records a successful result", async () => {
    const callId = await openCall();
    await recordCallEnd(callId, {});
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(providerPayload()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await runAssessmentTick(new Date(Date.now() + 6_000));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.assessmentJob.findUniqueOrThrow({ where: { callId_kind: { callId, kind: "POST_CALL" } } })).toMatchObject({ state: "SUCCEEDED", attempts: 1 });
    expect(await db.callAssessment.findFirstOrThrow({ where: { callId } })).toMatchObject({ status: "SUCCEEDED", requestedById: null });
  });
});
