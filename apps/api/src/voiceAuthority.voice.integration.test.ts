import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@msva/db";
import type { WorkerEvent } from "@msva/contracts";
import { claimVoiceLease, createVoiceSession, finalizeVoiceSession, invokeVoiceTool, prepareBrowserAdmission, recordVoiceDispatch, recordVoiceEvent, renewVoiceLease, voiceContext, workerParticipantIdentity } from "./voiceService.js";

const databaseUrl = process.env.MSVA_VOICE_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("MSVA_VOICE_TEST_DATABASE_URL is required");
process.env.VOICE_ENABLED = "true";
process.env.VOICE_WORKER_API_TOKEN = "worker-test-token";
process.env.VOICE_LEASE_SIGNING_KEY = "voice-test-signing-key";
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const worker = "Bearer worker-test-token";

beforeEach(async () => { await db.$executeRawUnsafe('TRUNCATE TABLE "ToolInvocation", "MediaControlIntent", "VoiceAdmission", "TranscriptSegment", "VoiceEvent", "VoiceLease", "VoiceParticipant", "VoiceSession", "Handoff", "Session", "User", "Call" CASCADE'); });
afterAll(() => db.$disconnect());

async function startedCall(label = "call") {
  const callId = `voice-${label}-${randomUUID()}`;
  await db.call.create({ data: { id: callId, provider: "BROWSER", isTest: true, fromNumber: "browser" } });
  const created = await createVoiceSession({ requestId: `request-${callId}`, callId, callerParticipantId: "caller", language: "hi" }, db);
  await recordVoiceDispatch(created.id, "dispatch", db);
  return { callId, sessionId: created.id, roomName: created.roomName };
}
async function liveCall(label?: string) {
  const call = await startedCall(label);
  const lease = await claimVoiceLease({ callId: call.callId, roomName: call.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(call.callId) }, worker, db);
  return { ...call, lease };
}
type Live = Awaited<ReturnType<typeof liveCall>>;
const envelope = (call: Live, sourceSequence: number) => ({ schemaVersion: 1 as const, eventId: `${call.callId}-${sourceSequence}`, callId: call.callId, agentEpoch: 1, sourceSequence, occurredAt: new Date().toISOString() });
const ready = (call: Live, seq: number): WorkerEvent => ({ ...envelope(call, seq), type: "agent.ready", payload: { participantId: workerParticipantIdentity(call.callId) } });
const callerFinal = (call: Live, seq: number, text = "doodh kharab tha"): WorkerEvent => ({ ...envelope(call, seq), type: "transcript.final", payload: { segmentId: `caller-${seq}`, revision: 1, speaker: "CALLER", participantId: "caller", sequence: seq, text, language: "hi" } });
const flushed = (call: Live, seq: number): WorkerEvent => ({ ...envelope(call, seq), type: "transcript.flushed", payload: { lastSourceSequence: seq - 1 } });
const complaint = { journey: "CONSUMER_COMPLAINT", callerConfirmation: "NEW", fields: { product: "Oil", purchaseArea: "Indore", issueCategory: "quality", description: "Leaking", productAvailable: true }, queue: { territory: "MP", language: "hi" } };
const tool = (call: Live, invocationId: string, args: unknown = complaint) => invokeVoiceTool({ callId: call.callId, invocationId, agentEpoch: 1, name: "create_business_request", arguments: args }, call.lease.token, db);

describe("worker authority", () => {
  it.each(["CONFIGURATION", "TRANSIENT", "FATAL", "LEASE_LOST"] as const)("fences every authority after a %s failure and keeps the call for staff", async (code) => {
    const call = await liveCall(code.toLowerCase());
    await recordVoiceEvent({ ...envelope(call, 1), type: "agent.failed", payload: { code } }, call.lease.token, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } })).toMatchObject({ state: "RECOVERY_REQUIRED" });
    expect(await db.call.findUniqueOrThrow({ where: { id: call.callId } })).toMatchObject({ status: "IN_PROGRESS", endedAt: null });
    await expect(renewVoiceLease(call.callId, 1, call.lease.token, db)).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    await expect(voiceContext(call.callId, call.lease.token, db)).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    await expect(tool(call, "after-failure")).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(await db.ticket.count()).toBe(0);
    // The failed worker may still drain its evidence.
    await expect(recordVoiceEvent(flushed(call, 2), call.lease.token, db)).resolves.toMatchObject({ status: "committed" });
  });

  it("judges lease expiry by the time after waiting for the session lock", async () => {
    const call = await liveCall();
    await db.voiceLease.updateMany({ where: { sessionId: call.sessionId }, data: { expiresAt: new Date(Date.now() + 300) } });
    let invoking!: ReturnType<typeof tool>;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "VoiceSession" WHERE "id" = ${call.sessionId} FOR UPDATE`;
      invoking = tool(call, "contended");
      await vi.waitFor(async () => {
        const [row] = await db.$queryRaw<{ waiting: bigint }[]>`SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        expect(Number(row!.waiting)).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 20 });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }, { timeout: 15_000 });
    await expect(invoking).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(await db.ticket.count()).toBe(0);
  });

  it("rejects worker acknowledgements without touching browser media controls", async () => {
    const call = await liveCall();
    const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, name: "Operator", role: "AGENT" } });
    const browser = await db.session.create({ data: { userId: user.id, tokenHash: "operator-token", expiresAt: new Date(Date.now() + 60_000) } });
    await db.handoff.create({ data: { callId: call.callId, assignedUserId: user.id, state: "ASSIGNED" } });
    const admission = await prepareBrowserAdmission({ callId: call.callId, userId: user.id, sessionId: browser.id, role: "OPERATOR_LISTENER", expectedAuthorizationVersion: 1 }, db);
    const control = await db.mediaControlIntent.create({ data: { admissionId: admission.id, authorizationVersion: 1, kind: "REMOVE", status: "RUNNING", attemptToken: "executor", leaseExpiresAt: new Date(Date.now() + 10_000) } });
    await expect(recordVoiceEvent({ ...envelope(call, 1), type: "control.ack", payload: { controlId: control.id, state: "PAUSED" } }, call.lease.token, db)).rejects.toMatchObject({ code: "CONTROL_ACK_INVALID" });
    expect(await db.mediaControlIntent.findUniqueOrThrow({ where: { id: control.id } })).toMatchObject({ status: "RUNNING", attemptToken: "executor" });
  });

  it("bounds how much evidence one call can ingest", async () => {
    const call = await liveCall();
    const first = ready(call, 1);
    await recordVoiceEvent(first, call.lease.token, db);
    await db.voiceSession.update({ where: { id: call.sessionId }, data: { eventCount: 5_000 } });
    await expect(recordVoiceEvent(callerFinal(call, 2), call.lease.token, db)).rejects.toMatchObject({ code: "EVENT_CAPACITY" });
    // Receipts for evidence already committed are still answered.
    await expect(recordVoiceEvent(first, call.lease.token, db)).resolves.toMatchObject({ status: "duplicate" });
    await db.voiceSession.update({ where: { id: call.sessionId }, data: { eventCount: 1, eventBytes: 8 * 1024 * 1024 - 10 } });
    await expect(recordVoiceEvent(callerFinal(call, 2), call.lease.token, db)).rejects.toMatchObject({ code: "EVENT_CAPACITY" });
  });
});

describe("call completion", () => {
  it("marks a call with no caller speech as abandoned", async () => {
    const call = await liveCall();
    await recordVoiceEvent(ready(call, 1), call.lease.token, db);
    await recordVoiceEvent(flushed(call, 2), call.lease.token, db);
    await finalizeVoiceSession(call.callId, db);
    const ended = await db.call.findUniqueOrThrow({ where: { id: call.callId } });
    expect(ended).toMatchObject({ status: "COMPLETED", outcome: "ABANDONED" });
    expect(ended.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("marks a call with a recorded request as ticket created", async () => {
    const call = await liveCall();
    await recordVoiceEvent(callerFinal(call, 1), call.lease.token, db);
    await tool(call, "complaint");
    await recordVoiceEvent(flushed(call, 2), call.lease.token, db);
    await finalizeVoiceSession(call.callId, db);
    expect(await db.call.findUniqueOrThrow({ where: { id: call.callId } })).toMatchObject({ status: "COMPLETED", outcome: "TICKET_CREATED" });
  });

  it("never replaces a stronger recorded outcome or claims resolution after a failure", async () => {
    const kept = await liveCall("kept");
    await db.call.update({ where: { id: kept.callId }, data: { outcome: "TICKET_CREATED" } });
    await recordVoiceEvent(ready(kept, 1), kept.lease.token, db);
    await recordVoiceEvent(flushed(kept, 2), kept.lease.token, db);
    await finalizeVoiceSession(kept.callId, db);
    expect(await db.call.findUniqueOrThrow({ where: { id: kept.callId } })).toMatchObject({ outcome: "TICKET_CREATED" });

    const failed = await liveCall("failed");
    await recordVoiceEvent(callerFinal(failed, 1), failed.lease.token, db);
    await recordVoiceEvent({ ...envelope(failed, 2), type: "agent.failed", payload: { code: "FATAL" } }, failed.lease.token, db);
    await recordVoiceEvent(flushed(failed, 3), failed.lease.token, db);
    await finalizeVoiceSession(failed.callId, db);
    expect(await db.call.findUniqueOrThrow({ where: { id: failed.callId } })).toMatchObject({ status: "COMPLETED", outcome: "IN_PROGRESS" });
  });
});

describe("session capacity and startup", () => {
  it("moves crashed-worker calls to recovery so new calls can start", async () => {
    const first = await liveCall("first");
    const second = await liveCall("second");
    await expect(startedCall("blocked")).rejects.toMatchObject({ code: "ACTIVE_CAPACITY" });
    await db.voiceLease.updateMany({ data: { expiresAt: new Date(Date.now() - 1) } });
    await expect(startedCall("after-crash")).resolves.toMatchObject({ callId: expect.any(String) });
    expect((await db.voiceSession.findMany({ where: { id: { in: [first.sessionId, second.sessionId] } } })).map((row) => row.state)).toEqual(["RECOVERY_REQUIRED", "RECOVERY_REQUIRED"]);
  });

  it("ends a call whose worker never claimed it before the startup deadline", async () => {
    const call = await startedCall();
    await db.voiceSession.update({ where: { id: call.sessionId }, data: { expiresAt: new Date(Date.now() - 1) } });
    const claim = { callId: call.callId, roomName: call.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(call.callId) };
    await expect(claimVoiceLease(claim, worker, db)).rejects.toMatchObject({ code: "SESSION_UNAVAILABLE" });
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } })).toMatchObject({ state: "FAILED" });
    const ended = await db.call.findUniqueOrThrow({ where: { id: call.callId } });
    expect(ended).toMatchObject({ status: "FAILED", outcome: "ABANDONED" });
    expect(ended.endedAt).not.toBeNull();
  });

  it("answers repeated claims on a call in recovery without changing it", async () => {
    const call = await liveCall();
    await db.voiceLease.updateMany({ where: { sessionId: call.sessionId }, data: { expiresAt: new Date(Date.now() - 1) } });
    const claim = { callId: call.callId, roomName: call.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(call.callId) };
    await expect(claimVoiceLease(claim, worker, db)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const before = await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } });
    await expect(claimVoiceLease(claim, worker, db)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } })).toMatchObject({ state: "RECOVERY_REQUIRED", authorizationVersion: before.authorizationVersion, currentEpoch: 1 });
  });

  it("treats an explicit default like an omitted field and refuses a second session per call", async () => {
    const callId = `voice-${randomUUID()}`;
    await db.call.create({ data: { id: callId, provider: "BROWSER", isTest: true, fromNumber: "browser" } });
    const first = await createVoiceSession({ requestId: "create-default", callId, callerParticipantId: "caller" }, db);
    expect((await createVoiceSession({ requestId: "create-default", callId, callerParticipantId: "caller", language: "hi" }, db)).id).toBe(first.id);
    await expect(createVoiceSession({ requestId: "create-other", callId, callerParticipantId: "caller" }, db)).rejects.toMatchObject({ code: "CALL_SESSION_EXISTS" });
  });
});

describe("business tools", () => {
  it("records a permanent rejection so a retry gets the same answer", async () => {
    const call = await liveCall();
    const followUp = { ...complaint, callerConfirmation: "FOLLOW_UP", parentRequestId: "missing-request" };
    await expect(tool(call, "follow-up", followUp)).rejects.toMatchObject({ status: 403, code: "PARENT_NOT_ACCESSIBLE" });
    await expect(tool(call, "follow-up", followUp)).rejects.toMatchObject({ status: 403, code: "PARENT_NOT_ACCESSIBLE" });
    expect(await db.toolInvocation.findFirstOrThrow({ where: { invocationId: "follow-up" } })).toMatchObject({ status: "FAILED", result: { error: "PARENT_NOT_ACCESSIBLE" } });
    expect(await db.ticket.count()).toBe(0);
  });

  it("accepts the longest allowed invocation identifier", async () => {
    const call = await liveCall();
    await expect(tool(call, "i".repeat(128))).resolves.toMatchObject({ ticketNumber: expect.any(Number) });
  });
});
