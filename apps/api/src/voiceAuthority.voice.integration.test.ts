import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@msva/db";
import type { WorkerEvent } from "@msva/contracts";
import { claimVoiceLease, createVoiceSession, endVoiceCall, finalizeVoiceSession, invokeVoiceTool, prepareBrowserAdmission, recordVoiceDispatch, recordVoiceEvent, renewVoiceLease, sweepVoiceSessions, voiceContext, voiceToolReceipt, workerParticipantIdentity } from "./voiceService.js";

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
const failed = (call: Live, seq: number, code: "FATAL" | "TRANSIENT" = "FATAL"): WorkerEvent => ({ ...envelope(call, seq), type: "agent.failed", payload: { code } });
/** Records that the call has already ingested this much, so a test can start at the limits. */
const alreadyIngested = (call: Live, events: number, bytes = 0) => db.voiceSessionUsage.upsert({ where: { sessionId: call.sessionId }, create: { sessionId: call.sessionId, events, bytes }, update: { events, bytes } });
const lockWaiters = (count: number) => vi.waitFor(async () => {
  const [row] = await db.$queryRaw<{ waiting: bigint }[]>`SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  expect(Number(row!.waiting)).toBe(count);
}, { timeout: 5_000, interval: 20 });
/**
 * Statistics from an ingestion history like a live database's (300 ended calls
 * of 30 events), left behind on emptied tables. They change how Postgres looks
 * an event up, and with it how a concurrent duplicate surfaces.
 */
async function withHistory() {
  await db.$executeRawUnsafe(`INSERT INTO "Call" ("id", "provider", "isTest", "fromNumber", "status", "outcome", "endedAt") SELECT 'history-' || g, 'BROWSER', true, 'browser', 'COMPLETED', 'ABANDONED', now() FROM generate_series(1, 300) AS g`);
  await db.$executeRawUnsafe(`INSERT INTO "VoiceSession" ("id", "callId", "roomName", "createRequestId", "createRequestHash", "dispatchIntentId", "state", "endedAt", "currentEpoch") SELECT 'history-' || g, 'history-' || g, 'room-history-' || g, 'request-history-' || g, 'h', 'dispatch-history-' || g, 'ENDED', now(), 1 FROM generate_series(1, 300) AS g`);
  await db.$executeRawUnsafe(`INSERT INTO "VoiceEvent" ("id", "sessionId", "eventId", "agentEpoch", "sourceSequence", "canonicalBody", "bodyHash", "type", "occurredAt") SELECT 'history-' || g || '-' || n, 'history-' || g, 'event-' || n, 1, n, repeat('x', 400), 'h', 'transcript.final', now() FROM generate_series(1, 300) AS g, generate_series(1, 30) AS n`);
  await db.$executeRawUnsafe(`ANALYZE "VoiceEvent", "VoiceSession", "Call"`);
  await db.$executeRawUnsafe('TRUNCATE TABLE "VoiceEvent", "VoiceSession", "Call" CASCADE');
}
async function signedIn(role: "ADMIN" | "SUPERVISOR" | "AGENT" | "VIEWER" = "AGENT") {
  const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, name: "Person", role } });
  const browser = await db.session.create({ data: { userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { userId: user.id, sessionId: browser.id };
}
/** A caller signed in to the console who owns the call and holds its caller admission. */
async function admittedCaller(call: Live) {
  const who = await signedIn();
  await db.voiceSession.update({ where: { id: call.sessionId }, data: { ownerUserId: who.userId, ownerSessionId: who.sessionId } });
  const admission = await prepareBrowserAdmission({ callId: call.callId, ...who, role: "CALLER", expectedAuthorizationVersion: 1 }, db);
  return { ...who, admission };
}
const crash = (call: Live, msAgo = 1) => db.voiceLease.updateMany({ where: { sessionId: call.sessionId }, data: { expiresAt: new Date(Date.now() - msAgo) } });

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

  it("bounds how many events one call can ingest, leaving room for one checkpoint", async () => {
    const call = await liveCall();
    await alreadyIngested(call, 4_999);
    const first = ready(call, 1);
    await recordVoiceEvent(first, call.lease.token, db);
    await expect(recordVoiceEvent(callerFinal(call, 2), call.lease.token, db)).rejects.toMatchObject({ code: "EVENT_CAPACITY" });
    // Receipts for evidence already committed are still answered.
    await expect(recordVoiceEvent(first, call.lease.token, db)).resolves.toMatchObject({ status: "duplicate" });
    // The stream may still end in a checkpoint, but only one.
    await expect(recordVoiceEvent(flushed(call, 2), call.lease.token, db)).resolves.toMatchObject({ status: "committed" });
    await expect(recordVoiceEvent(flushed(call, 3), call.lease.token, db)).rejects.toMatchObject({ code: "EVENT_CAPACITY" });
  });

  it("bounds how many bytes of evidence one call can ingest", async () => {
    const call = await liveCall();
    await alreadyIngested(call, 1, 8 * 1024 * 1024 - 10);
    await expect(recordVoiceEvent(ready(call, 1), call.lease.token, db)).rejects.toMatchObject({ code: "EVENT_CAPACITY" });
  });

  it("keeps renewals and tools working while events arrive back to back", async () => {
    const call = await liveCall();
    const failures: unknown[] = [];
    let streaming = true;
    const renewals = (async () => {
      let count = 0;
      while (streaming) {
        await renewVoiceLease(call.callId, 1, call.lease.token, db).then(() => { count += 1; }, (error) => { failures.push(error); });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return count;
    })();
    const tools = (async () => {
      for (let index = 0; index < 4; index += 1) {
        await tool(call, `busy-${index}`).catch((error) => { failures.push(error); });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    for (let seq = 1; seq <= 120; seq += 1) await recordVoiceEvent(callerFinal(call, seq, `utterance ${seq}`), call.lease.token, db);
    await tools;
    streaming = false;
    expect(await renewals).toBeGreaterThan(10);
    expect(failures).toEqual([]);
    expect(await db.ticket.count()).toBe(4);
  });

  it("never lets one call's evidence make another call's ingestion fail", async () => {
    const first = await liveCall("first");
    const second = await liveCall("second");
    const failures: unknown[] = [];
    const stream = async (call: Live) => {
      for (let seq = 1; seq <= 150; seq += 1) await recordVoiceEvent(callerFinal(call, seq, `utterance ${seq}`), call.lease.token, db).catch((error) => { failures.push(error); });
    };
    let streaming = true;
    const renewals = (async () => {
      while (streaming) {
        for (const call of [first, second]) await renewVoiceLease(call.callId, 1, call.lease.token, db).catch((error) => { failures.push(error); });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    await Promise.all([stream(first), stream(second)]);
    streaming = false;
    await renewals;
    expect(failures).toEqual([]);
    expect(await db.voiceEvent.count()).toBe(300);
  });

  it("answers a repeated event sent while the first is still being stored", async () => {
    await withHistory();
    const call = await liveCall();
    const event = ready(call, 1);
    let copies!: Array<ReturnType<typeof recordVoiceEvent>>;
    // Both copies wait for the session, so the second reads from before the first commits.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "VoiceSession" WHERE "id" = ${call.sessionId} FOR UPDATE`;
      copies = [recordVoiceEvent(event, call.lease.token, db), recordVoiceEvent(event, call.lease.token, db)];
      await lockWaiters(2);
    }, { timeout: 15_000 });
    expect((await Promise.all(copies)).map((result) => result.status).sort()).toEqual(["committed", "duplicate"]);
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

describe("ending calls without complete evidence", () => {
  it("ends a call whose worker crashed before its checkpoint, and completes it when the flush arrives late", async () => {
    const call = await liveCall();
    const caller = await admittedCaller(call);
    await recordVoiceEvent(callerFinal(call, 1), call.lease.token, db);
    await crash(call);
    await finalizeVoiceSession(call.callId, db);
    const ended = await db.call.findUniqueOrThrow({ where: { id: call.callId } });
    expect(ended).toMatchObject({ status: "COMPLETED", outcome: "IN_PROGRESS" });
    expect(ended.endedAt).not.toBeNull();
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } })).toMatchObject({ state: "ENDED", transcriptComplete: false });
    expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: caller.admission.id } })).toMatchObject({ state: "REVOKING", revokeReason: "CALL_ENDED" });
    expect(await db.mediaControlIntent.count({ where: { admissionId: caller.admission.id, kind: "REMOVE" } })).toBe(1);
    await recordVoiceEvent(flushed(call, 2), call.lease.token, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } })).toMatchObject({ state: "ENDED", transcriptComplete: true });
  });

  it("ends a call after a fatal failure without a checkpoint, and corrects its outcome from late evidence", async () => {
    const call = await liveCall();
    await recordVoiceEvent(ready(call, 1), call.lease.token, db);
    await recordVoiceEvent(failed(call, 2), call.lease.token, db);
    await finalizeVoiceSession(call.callId, db);
    expect(await db.call.findUniqueOrThrow({ where: { id: call.callId } })).toMatchObject({ status: "COMPLETED", outcome: "ABANDONED" });
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } })).toMatchObject({ state: "ENDED", transcriptComplete: false });
    // The caller's speech was still in the worker's spool when the call ended.
    await recordVoiceEvent(callerFinal(call, 3), call.lease.token, db);
    expect(await db.call.findUniqueOrThrow({ where: { id: call.callId } })).toMatchObject({ outcome: "ABANDONED" });
    await recordVoiceEvent(flushed(call, 4), call.lease.token, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } })).toMatchObject({ transcriptComplete: true });
    expect(await db.call.findUniqueOrThrow({ where: { id: call.callId } })).toMatchObject({ status: "COMPLETED", outcome: "IN_PROGRESS" });
  });

  it("ends a call whose evidence reached the ingestion limit", async () => {
    const call = await liveCall();
    await alreadyIngested(call, 4_999);
    await recordVoiceEvent(ready(call, 1), call.lease.token, db);
    await expect(recordVoiceEvent(callerFinal(call, 2), call.lease.token, db)).rejects.toMatchObject({ code: "EVENT_CAPACITY" });
    await finalizeVoiceSession(call.callId, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } })).toMatchObject({ state: "ENDED", transcriptComplete: false });
    expect((await db.call.findUniqueOrThrow({ where: { id: call.callId } })).endedAt).not.toBeNull();
  });

  it("lets the caller, an assigned operator or a supervisor end a call in recovery, and nobody else", async () => {
    const call = await liveCall();
    const caller = await admittedCaller(call);
    await recordVoiceEvent(failed(call, 1), call.lease.token, db);
    const bystander = await signedIn("AGENT");
    const viewer = await signedIn("VIEWER");
    for (const who of [bystander, viewer]) await expect(endVoiceCall({ callId: call.callId, ...who }, db)).rejects.toMatchObject({ status: 403, code: "END_DENIED" });
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } })).toMatchObject({ state: "RECOVERY_REQUIRED" });
    await endVoiceCall({ callId: call.callId, userId: caller.userId, sessionId: caller.sessionId }, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } })).toMatchObject({ state: "ENDED" });
    // Ending an ended call changes nothing.
    const endedAt = (await db.call.findUniqueOrThrow({ where: { id: call.callId } })).endedAt;
    await endVoiceCall({ callId: call.callId, userId: caller.userId, sessionId: caller.sessionId }, db);
    expect((await db.call.findUniqueOrThrow({ where: { id: call.callId } })).endedAt).toEqual(endedAt);

    const operatorCall = await liveCall("operator");
    const operator = await signedIn("AGENT");
    await db.handoff.create({ data: { callId: operatorCall.callId, assignedUserId: operator.userId, state: "ASSIGNED" } });
    await endVoiceCall({ callId: operatorCall.callId, ...operator }, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: operatorCall.sessionId } })).toMatchObject({ state: "ENDED" });

    const supervisedCall = await liveCall("supervised");
    await endVoiceCall({ callId: supervisedCall.callId, ...(await signedIn("SUPERVISOR")) }, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: supervisedCall.sessionId } })).toMatchObject({ state: "ENDED" });
  });
});

describe("abandoned calls", () => {
  it("closes a recovery call that waited with nobody admitted, and only that one", async () => {
    const abandoned = await liveCall("abandoned");
    await recordVoiceEvent(callerFinal(abandoned, 1), abandoned.lease.token, db);
    await recordVoiceEvent(failed(abandoned, 2), abandoned.lease.token, db);
    await crash(abandoned, 16 * 60_000);
    const recent = await liveCall("recent");
    await recordVoiceEvent(failed(recent, 1), recent.lease.token, db);
    await crash(recent, 5 * 60_000);
    expect(await sweepVoiceSessions(db)).toBe(1);
    const closed = await db.call.findUniqueOrThrow({ where: { id: abandoned.callId } });
    expect(closed).toMatchObject({ status: "FAILED", outcome: "IN_PROGRESS" });
    expect(closed.endedAt).not.toBeNull();
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: abandoned.sessionId } })).toMatchObject({ state: "FAILED", transcriptComplete: false });
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: recent.sessionId } })).toMatchObject({ state: "RECOVERY_REQUIRED" });
    expect(await sweepVoiceSessions(db)).toBe(0);
  });

  it("keeps a recovery call open while someone is still admitted to it", async () => {
    const call = await liveCall();
    await admittedCaller(call);
    await recordVoiceEvent(failed(call, 1), call.lease.token, db);
    await crash(call, 16 * 60_000);
    expect(await sweepVoiceSessions(db)).toBe(0);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: call.sessionId } })).toMatchObject({ state: "RECOVERY_REQUIRED" });
  });

  it("hands a crashed AI worker's call to recovery but leaves a human-owned call alone", async () => {
    const crashed = await liveCall("crashed");
    await crash(crashed);
    const human = await liveCall("human");
    await db.voiceSession.update({ where: { id: human.sessionId }, data: { ownershipMode: "HUMAN" } });
    await crash(human);
    await sweepVoiceSessions(db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: crashed.sessionId } })).toMatchObject({ state: "RECOVERY_REQUIRED" });
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: human.sessionId } })).toMatchObject({ state: "ACTIVE", ownershipMode: "HUMAN" });
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

  it("refuses invalid arguments before recording anything", async () => {
    const call = await liveCall();
    // Text PostgreSQL cannot store is refused too, instead of failing on every retry.
    const unstorable = [String.fromCharCode(0), String.fromCharCode(0xd800)].map((bad) => ({ ...complaint, fields: { ...complaint.fields, description: `Leaking${bad}` } }));
    for (const args of [null, ["a list"], { ...complaint, journey: "NOT_A_JOURNEY" }, ...unstorable]) {
      await expect(tool(call, "invalid", args)).rejects.toMatchObject({ status: 400, code: "INVALID_TOOL_ARGUMENTS" });
    }
    expect(await db.toolInvocation.count()).toBe(0);
    await expect(voiceToolReceipt(call.callId, "invalid", call.lease.token, db)).rejects.toMatchObject({ status: 404, code: "TOOL_RECEIPT_NOT_FOUND" });
  });

  it("refuses more than five business requests in one call but still answers earlier ones", async () => {
    const call = await liveCall();
    const receipts = [];
    for (let index = 0; index < 5; index += 1) receipts.push(await tool(call, `request-${index}`));
    await expect(tool(call, "request-5")).rejects.toMatchObject({ status: 409, code: "TOOL_LIMIT" });
    expect(await db.ticket.count()).toBe(5);
    await expect(tool(call, "request-0")).resolves.toEqual(receipts[0]);
  });

  it("accepts the longest allowed invocation identifier", async () => {
    const call = await liveCall();
    await expect(tool(call, "i".repeat(128))).resolves.toMatchObject({ ticketNumber: expect.any(Number) });
  });
});
