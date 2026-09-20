import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@msva/db";
import { getCallAssessment, requestCallAssessment } from "./callAssessment.js";

const databaseUrl = process.env.JEV_TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("/msva_jev_test") || process.env.DATABASE_URL !== databaseUrl) {
  throw new Error("DATABASE_URL and JEV_TEST_DATABASE_URL must both point to the disposable msva_jev_test database.");
}

const db = new PrismaClient({ datasourceUrl: databaseUrl });
const callIds: string[] = [];
const userIds: string[] = [];
const callerIds: string[] = [];

const choices = {
  repetition: ["repetitive", "not_repetitive", "insufficient_context"],
  callerSentiment: ["positive", "neutral", "frustrated", "unclear"],
  followUpNeed: ["indicated", "not_indicated", "unclear"],
  ticketCreationClaim: ["claimed", "not_claimed", "unclear"],
  journey: ["consumer_complaint", "retailer_enquiry", "distributor_support", "sales_interest", "unclear"],
  urgency: ["possible_safety", "routine", "unclear"]
} as const;

const answer = <T extends string>(choice: T, options: readonly T[]) => ({
  type: "choice",
  choice,
  probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 1 : 0])),
  confidence: 1
});

function providerPayload() {
  return {
    model: "jev-1.13.0",
    answers: {
      repetition: answer("not_repetitive", choices.repetition),
      callerSentiment: answer("neutral", choices.callerSentiment),
      followUpNeed: answer("not_indicated", choices.followUpNeed),
      ticketCreationClaim: answer("not_claimed", choices.ticketCreationClaim),
      journey: answer("retailer_enquiry", choices.journey),
      urgency: answer("routine", choices.urgency)
    },
    usage: { input_tokens: 10, output_tokens: 8 }
  };
}

beforeEach(() => {
  vi.stubEnv("JEV_ENABLED", "true");
  vi.stubEnv("JEV_API_KEY", "test-key");
  vi.stubEnv("JEV_ALLOWED_ORIGINS", "https://console.test");
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entity: "CallAssessment", entityId: { not: null } } });
  await db.callAssessment.deleteMany({ where: { callId: { in: callIds } } });
  await db.call.deleteMany({ where: { id: { in: callIds } } });
  await db.caller.deleteMany({ where: { id: { in: callerIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

async function completedCall(): Promise<string> {
  const id = `jev-integration-${randomUUID()}`;
  callIds.push(id);
  await db.call.create({
    data: {
      id,
      provider: "BROWSER",
      isTest: true,
      fromNumber: "browser",
      status: "COMPLETED",
      endedAt: new Date(),
      outcome: "IN_PROGRESS",
      utterances: { create: { seq: 1, speaker: "CALLER", text: "Please call me tomorrow." } }
    }
  });
  return id;
}

async function completedCallWithKnownCaller(): Promise<string> {
  const callerId = `jev-caller-${randomUUID()}`;
  callerIds.push(callerId);
  await db.caller.create({ data: { id: callerId, phone: `fixture-${randomUUID()}`, name: "Asha Sharma" } });
  const id = `jev-integration-${randomUUID()}`;
  callIds.push(id);
  await db.call.create({
    data: {
      id, provider: "BROWSER", isTest: true, fromNumber: "+919876543210", callerId,
      status: "COMPLETED", endedAt: new Date(), outcome: "IN_PROGRESS",
      utterances: { create: { seq: 1, speaker: "CALLER", text: "asha sharma wrote a@example.test from 9876543210" } }
    }
  });
  return id;
}

async function supervisor(): Promise<string> {
  const id = `jev-user-${randomUUID()}`;
  userIds.push(id);
  await db.user.create({ data: { id, email: `${id}@test.invalid`, name: "Assessment supervisor", role: "SUPERVISOR" } });
  return id;
}

function mockProvider(payload = providerPayload()) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("CallAssessment migration and service", () => {
  it("keeps disabled POST and GET entirely offline", async () => {
    const callId = await completedCall();
    vi.stubEnv("JEV_ENABLED", "false");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getCallAssessment(callId)).toMatchObject({ found: true, response: { capability: { available: false, reason: "DISABLED" } } });
    expect(await requestCallAssessment(callId, await supervisor())).toMatchObject({ found: true, unavailable: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores an additive snapshot without changing its Call lifecycle", async () => {
    const callId = await completedCall();
    await db.callAssessment.create({
      data: {
        callId, inputHash: "a".repeat(64), requestedModel: "jev-1.13.0", rubricVersion: "msva-post-call-v1",
        preprocessingVersion: "msva-redaction-v1", status: "FAILED", attemptToken: randomUUID(),
        inputCharCount: 12, utteranceCount: 1, errorCode: "PROVIDER_UNAVAILABLE", completedAt: new Date()
      }
    });
    const call = await db.call.findUniqueOrThrow({ where: { id: callId } });
    expect(call).toMatchObject({ status: "COMPLETED", outcome: "IN_PROGRESS" });
    expect(await db.callAssessment.count({ where: { callId } })).toBe(1);
  });

  it("enforces one cached assessment identity per fingerprint and model", async () => {
    const callId = await completedCall();
    const data = {
      callId, inputHash: "b".repeat(64), requestedModel: "jev-1.13.0", rubricVersion: "msva-post-call-v1",
      preprocessingVersion: "msva-redaction-v1", status: "RUNNING" as const, attemptToken: randomUUID(),
      inputCharCount: 12, utteranceCount: 1, leaseExpiresAt: new Date(Date.now() + 30_000)
    };
    await db.callAssessment.create({ data });
    await expect(db.callAssessment.create({ data: { ...data, attemptToken: randomUUID() } })).rejects.toThrow();
  });

  it("claims concurrent requests once, sends the documented payload, and replays the cache", async () => {
    const callId = await completedCall();
    const userId = await supervisor();
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    vi.stubGlobal("fetch", fetchMock);

    const first = requestCallAssessment(callId, userId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = await requestCallAssessment(callId, userId);
    expect(second.pending).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    const request = JSON.parse(String(init.body));
    expect(request).toMatchObject({ model: "jev-1.13.0", questions: { repetition: { type: "choice" }, urgency: { type: "choice" } } });
    expect(request).not.toHaveProperty("choices");
    expect(request.questions.ticketCreationClaim.instructions).toContain("negated");

    resolveResponse!(new Response(JSON.stringify(providerPayload()), { status: 200 }));
    const completed = await first;
    expect(completed.response?.assessment).toMatchObject({ status: "SUCCEEDED", result: { linkedTicketRecorded: false } });
    expect(await db.callAssessment.count({ where: { callId } })).toBe(1);
    expect(await db.auditLog.count({ where: { entity: "CallAssessment", entityId: completed.response?.assessment?.id } })).toBe(2);

    const replay = await requestCallAssessment(callId, userId);
    expect(replay.response?.assessment?.id).toBe(completed.response?.assessment?.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("persists failure with audit, then safely reclaims after cooldown", async () => {
    const callId = await completedCall();
    const userId = await supervisor();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
    const failed = await requestCallAssessment(callId, userId);
    const failedId = failed.response?.assessment?.id;
    expect(failed.response?.assessment).toMatchObject({ status: "FAILED", errorCode: "RATE_LIMITED", retryable: false });
    expect(await db.auditLog.count({ where: { entity: "CallAssessment", entityId: failedId } })).toBe(2);

    await db.callAssessment.update({ where: { id: failedId }, data: { completedAt: new Date(Date.now() - 30_001) } });
    const fetchMock = mockProvider();
    const recovered = await requestCallAssessment(callId, userId);
    expect(recovered.response?.assessment).toMatchObject({ id: failedId, status: "SUCCEEDED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.callAssessment.findUniqueOrThrow({ where: { id: failedId } })).toMatchObject({ attemptCount: 2 });
    expect(await db.auditLog.count({ where: { entity: "CallAssessment", entityId: failedId } })).toBe(4);
  });

  it("keeps an actual old provider completion from overwriting its reclaimed attempt", async () => {
    const callId = await completedCall();
    const userId = await supervisor();
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolvers.push(resolve); }));
    vi.stubGlobal("fetch", fetchMock);
    const oldAttempt = requestCallAssessment(callId, userId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstRecord = await db.callAssessment.findFirstOrThrow({ where: { callId } });
    await db.callAssessment.update({ where: { id: firstRecord.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });

    const successor = requestCallAssessment(callId, userId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolvers[1](new Response(JSON.stringify(providerPayload()), { status: 200 }));
    const successorResult = await successor;
    const beforeOldCompletion = await db.callAssessment.findUniqueOrThrow({ where: { id: firstRecord.id } });
    expect(successorResult.response?.assessment).toMatchObject({ id: firstRecord.id, status: "SUCCEEDED" });
    expect(beforeOldCompletion.attemptCount).toBe(2);

    resolvers[0](new Response(JSON.stringify(providerPayload()), { status: 200 }));
    await oldAttempt;
    const afterOldCompletion = await db.callAssessment.findUniqueOrThrow({ where: { id: firstRecord.id } });
    expect(afterOldCompletion).toMatchObject({ status: "SUCCEEDED", attemptCount: 2, attemptToken: beforeOldCompletion.attemptToken });
    expect(await db.auditLog.count({ where: { entity: "CallAssessment", entityId: firstRecord.id } })).toBe(3);
  });

  it("returns the current cached A assessment after A-to-B-to-A transcript changes", async () => {
    const callId = await completedCall();
    const userId = await supervisor();
    const fetchMock = mockProvider();
    const first = await requestCallAssessment(callId, userId);
    const firstId = first.response?.assessment?.id;
    await db.utterance.updateMany({ where: { callId, seq: 1 }, data: { text: "Please call me after lunch." } });
    const second = await requestCallAssessment(callId, userId);
    expect(second.response?.assessment?.id).not.toBe(firstId);
    await db.utterance.updateMany({ where: { callId, seq: 1 }, data: { text: "Please call me tomorrow." } });

    const replay = await requestCallAssessment(callId, userId);
    const refreshed = await getCallAssessment(callId);
    expect(replay.response?.assessment?.id).toBe(firstId);
    expect(replay.response?.current).toBe(true);
    expect(refreshed.response?.assessment?.id).toBe(firstId);
    expect(refreshed.response?.current).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries an older current fingerprint and selects that current attempt after GET", async () => {
    const callId = await completedCall();
    const userId = await supervisor();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
    const failedA = await requestCallAssessment(callId, userId);
    const failedId = failedA.response?.assessment?.id;
    await db.utterance.updateMany({ where: { callId, seq: 1 }, data: { text: "Please call me after lunch." } });
    mockProvider();
    await requestCallAssessment(callId, userId);
    await db.utterance.updateMany({ where: { callId, seq: 1 }, data: { text: "Please call me tomorrow." } });
    await db.callAssessment.update({ where: { id: failedId }, data: { completedAt: new Date(Date.now() - 30_001) } });

    const retry = await requestCallAssessment(callId, userId);
    const refreshed = await getCallAssessment(callId);
    expect(retry.response?.assessment).toMatchObject({ id: failedId, status: "SUCCEEDED" });
    expect(retry.response?.current).toBe(true);
    expect(refreshed.response?.assessment?.id).toBe(failedId);
    expect(refreshed.response?.current).toBe(true);
  });

  it("does not claim a row or invoke a provider when request audit insertion rolls back", async () => {
    const callId = await completedCall();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await db.$executeRawUnsafe(`
      CREATE FUNCTION jev_reject_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'call_assessment.requested' THEN RAISE EXCEPTION 'audit rejected for test'; END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await db.$executeRawUnsafe('CREATE TRIGGER jev_reject_request_audit_trigger BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION jev_reject_request_audit();');
    try {
      await expect(requestCallAssessment(callId, await supervisor())).rejects.toThrow("audit rejected for test");
      expect(await db.callAssessment.count({ where: { callId } })).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS jev_reject_request_audit_trigger ON "AuditLog";');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS jev_reject_request_audit();');
    }
  });

  it("keeps missing configuration and ineligible snapshots offline", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const validCall = await completedCall();
    vi.stubEnv("JEV_API_KEY", "");
    expect(await requestCallAssessment(validCall, await supervisor())).toMatchObject({ found: true, unavailable: true });
    vi.stubEnv("JEV_API_KEY", "test-key");
    const emptyCall = await completedCall();
    await db.utterance.deleteMany({ where: { callId: emptyCall } });
    expect((await requestCallAssessment(emptyCall, await supervisor())).response?.eligibility).toEqual({ eligible: false, reason: "NO_TRANSCRIPT" });
    const oversizedCall = await completedCall();
    await db.utterance.updateMany({ where: { callId: oversizedCall }, data: { text: "x".repeat(24_001) } });
    expect((await requestCallAssessment(oversizedCall, await supervisor())).response?.eligibility).toEqual({ eligible: false, reason: "TRANSCRIPT_TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts linked Caller data in the real outbound payload and stores malformed provider failure safely", async () => {
    const callId = await completedCallWithKnownCaller();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.state).toEqual(expect.objectContaining({ transcript: "CALLER: [REDACTED] wrote [EMAIL] from [PHONE]", linkedTicketRecorded: false }));
      expect(Object.keys(request.state).sort()).toEqual(["language", "linkedTicketRecorded", "transcript"]);
      expect(request.state.transcript).not.toMatch(/Asha|asha|9876543210|ticket/i);
      return new Response("not-json", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await requestCallAssessment(callId, await supervisor());
    expect(response.response?.assessment).toMatchObject({ status: "FAILED", errorCode: "RESPONSE_INVALID" });
    expect(await db.auditLog.count({ where: { entity: "CallAssessment", entityId: response.response?.assessment?.id } })).toBe(2);
  });

  it("refreshes the saved snapshot after provider completion before declaring it current", async () => {
    const callId = await completedCall();
    const userId = await supervisor();
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = requestCallAssessment(callId, userId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await db.utterance.create({ data: { callId, seq: 2, speaker: "AGENT", text: "A ticket was recorded." } });
    resolveResponse!(new Response(JSON.stringify(providerPayload()), { status: 200 }));
    const response = await pending;
    expect(response.response?.current).toBe(false);
    expect((await getCallAssessment(callId)).response?.current).toBe(false);
  });
});
