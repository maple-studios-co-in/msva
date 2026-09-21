import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@msva/db";
import { recordCallEnd } from "./calls.js";
import { recordTurn } from "./calls.js";
import { runAssessmentTick } from "./assessmentJobs.js";
import { createTicket } from "./tools/crm.js";

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

  it("keeps an old provider result historical when a late transcript changes the generation", async () => {
    const callId = await openCall();
    await recordCallEnd(callId, {});
    let resolveProvider: ((response: Response) => void) | undefined;
    const provider = new Promise<Response>((resolve) => { resolveProvider = resolve; });
    const fetchMock = vi.fn(() => provider);
    vi.stubGlobal("fetch", fetchMock);

    const tick = runAssessmentTick(new Date(Date.now() + 6_000));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await recordTurn(callId, { index: 2, callerText: "Please call me after lunch." });
    resolveProvider?.(new Response(JSON.stringify(providerPayload()), { status: 200 }));
    await tick;

    expect(await db.assessmentJob.findUniqueOrThrow({ where: { callId_kind: { callId, kind: "POST_CALL" } } })).toMatchObject({ state: "PENDING", generation: 2, attempts: 0 });
    expect(await db.callAssessment.findFirstOrThrow({ where: { callId } })).toMatchObject({ status: "SUCCEEDED" });
  });

  it("does not launch a provider snapshot that changed while its assessment claim was blocked", async () => {
    const callId = await openCall();
    await recordCallEnd(callId, {});
    let releaseLock!: () => void;
    let lockAcquired!: () => void;
    const holdLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    const lockReady = new Promise<void>((resolve) => { lockAcquired = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(913421)");
      lockAcquired();
      await holdLock;
    }, { timeout: 15_000 });
    await lockReady;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION auto_assessment_preinvoke_wait() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.meta->>'callId' = '${callId}' THEN PERFORM pg_advisory_xact_lock(913421); END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await db.$executeRawUnsafe('CREATE TRIGGER auto_assessment_preinvoke_wait_trigger BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION auto_assessment_preinvoke_wait();');
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const tick = runAssessmentTick(new Date(Date.now() + 6_000));
      await vi.waitFor(async () => {
        const waiting = await db.$queryRawUnsafe<Array<{ wait_event: string | null }>>("SELECT wait_event FROM pg_stat_activity WHERE wait_event = 'advisory'");
        expect(waiting.length).toBeGreaterThan(0);
      });
      await recordTurn(callId, { index: 2, callerText: "A newer final message before provider invocation." });

      releaseLock();
      await blocker;
      await tick;

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await db.assessmentJob.findUniqueOrThrow({ where: { callId_kind: { callId, kind: "POST_CALL" } } })).toMatchObject({ state: "PENDING", generation: 2, attempts: 0 });
      expect(await db.callAssessment.findFirstOrThrow({ where: { callId } })).toMatchObject({ status: "FAILED", errorCode: "INPUT_CHANGED" });
    } finally {
      releaseLock();
      await blocker.catch(() => undefined);
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS auto_assessment_preinvoke_wait_trigger ON "AuditLog";');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS auto_assessment_preinvoke_wait();');
    }
  });

  it("creates a new queued generation when a late linked ticket changes assessment input", async () => {
    const callId = await openCall();
    await recordCallEnd(callId, {});
    const before = await db.assessmentJob.findUniqueOrThrow({ where: { callId_kind: { callId, kind: "POST_CALL" } } });

    expect((await createTicket(callId, { phone: "", intent: "delivery_delay", summary: "Late delivery" })).ok).toBe(true);

    expect(await db.assessmentJob.findUniqueOrThrow({ where: { callId_kind: { callId, kind: "POST_CALL" } } })).toMatchObject({ state: "PENDING", generation: 2, lastInputHash: expect.not.stringMatching(new RegExp(`^${before.lastInputHash}$`)) });
  });

  it("does not retry authentication failures automatically", async () => {
    const callId = await openCall();
    await recordCallEnd(callId, {});
    const fetchMock = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await runAssessmentTick(new Date(Date.now() + 6_000));
    await runAssessmentTick(new Date(Date.now() + 60_000));

    expect(await db.assessmentJob.findUniqueOrThrow({ where: { callId_kind: { callId, kind: "POST_CALL" } } })).toMatchObject({ state: "FAILED", attempts: 1, reason: "AUTH_FAILED" });
  });

  it("backs off a rate-limited provider request after reserving one attempt", async () => {
    const callId = await openCall();
    await recordCallEnd(callId, {});
    const fetchMock = vi.fn(async () => new Response("slow down", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await runAssessmentTick(new Date(Date.now() + 6_000));

    expect(fetchMock).toHaveBeenCalledOnce();
    const job = await db.assessmentJob.findUniqueOrThrow({ where: { callId_kind: { callId, kind: "POST_CALL" } } });
    expect(job).toMatchObject({ state: "PENDING", attempts: 1, reason: "RATE_LIMITED" });
    expect(job.dueAt.getTime()).toBeGreaterThan(Date.now() + 25_000);
  });

  it("recovers an expired worker claim without accepting its stale token", async () => {
    const callId = await openCall();
    await recordCallEnd(callId, {});
    const job = await db.assessmentJob.findUniqueOrThrow({ where: { callId_kind: { callId, kind: "POST_CALL" } } });
    const expired = new Date(Date.now() - 1_000);
    await db.assessmentJob.update({ where: { id: job.id }, data: { state: "RUNNING", claimedGeneration: job.generation, leaseToken: "stale-worker", leaseExpiresAt: expired } });
    await db.assessmentWorkerSlot.upsert({ where: { slot: 0 }, create: { slot: 0, ownerToken: "stale-worker", jobId: job.id, leaseExpiresAt: expired }, update: { ownerToken: "stale-worker", jobId: job.id, leaseExpiresAt: expired } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(providerPayload()), { status: 200 })));

    await runAssessmentTick(new Date(Date.now() + 6_000));

    expect(await db.assessmentJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: "SUCCEEDED", attempts: 1, leaseToken: null });
    expect(await db.assessmentWorkerSlot.findUniqueOrThrow({ where: { slot: 0 } })).toMatchObject({ ownerToken: null, jobId: null });
  });

  it("rejects a literal stale worker completion after a second worker takes over", async () => {
    const callId = await openCall();
    await recordCallEnd(callId, {});
    const releases: Array<() => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      releases.push(() => resolve(new Response(JSON.stringify(providerPayload()), { status: 200 })));
    })));

    const firstRunner = runAssessmentTick(new Date(Date.now() + 6_000));
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const staleJob = await db.assessmentJob.findUniqueOrThrow({ where: { callId_kind: { callId, kind: "POST_CALL" } } });
    const staleAssessment = await db.callAssessment.findFirstOrThrow({ where: { callId } });
    const expired = new Date(Date.now() - 1_000);
    await db.$transaction(async (tx) => {
      await tx.assessmentJob.update({ where: { id: staleJob.id }, data: { leaseExpiresAt: expired } });
      await tx.assessmentWorkerSlot.updateMany({ where: { ownerToken: staleJob.leaseToken, jobId: staleJob.id }, data: { leaseExpiresAt: expired } });
      await tx.callAssessment.update({ where: { id: staleAssessment.id }, data: { leaseExpiresAt: expired } });
    });

    const secondRunner = runAssessmentTick(new Date(Date.now() + 6_000));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const replacement = await db.assessmentJob.findUniqueOrThrow({ where: { id: staleJob.id } });
    const replacementAssessment = await db.callAssessment.findUniqueOrThrow({ where: { id: staleAssessment.id } });
    expect(replacement).toMatchObject({ state: "RUNNING", leaseToken: expect.not.stringMatching(new RegExp(`^${staleJob.leaseToken}$`)) });
    expect(replacementAssessment).toMatchObject({ status: "RUNNING", attemptToken: expect.not.stringMatching(new RegExp(`^${staleAssessment.attemptToken}$`)) });

    releases[0]!();
    await vi.waitFor(async () => {
      expect(await db.callAssessment.findUniqueOrThrow({ where: { id: staleAssessment.id } })).toMatchObject({ status: "RUNNING", attemptToken: replacementAssessment.attemptToken });
      expect(await db.assessmentJob.findUniqueOrThrow({ where: { id: staleJob.id } })).toMatchObject({ state: "RUNNING", leaseToken: replacement.leaseToken });
    });

    releases[1]!();
    await Promise.all([firstRunner, secondRunner]);
    expect(await db.assessmentJob.findUniqueOrThrow({ where: { id: staleJob.id } })).toMatchObject({ state: "SUCCEEDED", attempts: 2 });
  });

  it("keeps two slots authoritative when a delayed tick starts with an expired clock", async () => {
    const ids = await Promise.all([openCall(), openCall(), openCall()]);
    await Promise.all(ids.map((callId) => recordCallEnd(callId, {})));
    const delayedTickAt = new Date(Date.now() - 60_000);
    await db.assessmentJob.updateMany({ where: { callId: { in: ids } }, data: { dueAt: delayedTickAt } });

    let holdRequests = true;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const releaseRequests: Array<() => void> = [];
    const fetchMock = vi.fn(() => {
      if (!holdRequests) return Promise.resolve(new Response(JSON.stringify(providerPayload()), { status: 200 }));
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      return new Promise<Response>((resolve) => releaseRequests.push(() => {
        activeRequests--;
        resolve(new Response(JSON.stringify(providerPayload()), { status: 200 }));
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const delayedRunner = runAssessmentTick(delayedTickAt);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const freshRunners = [runAssessmentTick(new Date()), runAssessmentTick(new Date())];
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The first worker's claim must be leased from wall-clock time, so the
    // two fresh workers can occupy only the remaining persisted slot.
    expect(maxActiveRequests).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    holdRequests = false;
    releaseRequests.splice(0).forEach((release) => release());
    await Promise.all([delayedRunner, ...freshRunners]);
  });

  it("keeps a changed inactive job skipped when concurrent admission is at capacity", async () => {
    const callId = await openCall();
    await recordCallEnd(callId, {});
    await db.assessmentJob.update({ where: { callId_kind: { callId, kind: "POST_CALL" } }, data: { state: "SUCCEEDED" } });
    const saturationIds = Array.from({ length: 1_000 }, (_, index) => `auto-cap-${index}-${randomUUID()}`);
    callIds.push(...saturationIds);
    await db.call.createMany({ data: saturationIds.map((id) => ({ id, provider: "BROWSER" as const, isTest: true, fromNumber: "browser", status: "IN_PROGRESS", outcome: "IN_PROGRESS" })) });
    await db.assessmentJob.createMany({ data: saturationIds.map((id) => ({ callId: id, kind: "POST_CALL" as const, state: "PENDING" as const, dueAt: new Date(), source: "AUTO_POST_CALL" })) });

    await recordTurn(callId, { index: 2, callerText: "A changed final detail." });

    expect(await db.assessmentJob.findUniqueOrThrow({ where: { callId_kind: { callId, kind: "POST_CALL" } } })).toMatchObject({ state: "SKIPPED", reason: "QUEUE_CAPACITY" });
  });

});
