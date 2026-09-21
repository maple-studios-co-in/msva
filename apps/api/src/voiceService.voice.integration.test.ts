import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@msva/db";
import { claimVoiceLease, createVoiceSession, invokeVoiceTool, prepareBrowserAdmission, recordVoiceDispatch, recordVoiceEvent, renewVoiceLease, revokeAdmissions, VoiceError, voiceContext, workerParticipantIdentity } from "./voiceService.js";

const databaseUrl = process.env.MSVA_VOICE_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("MSVA_VOICE_TEST_DATABASE_URL is required");
process.env.VOICE_ENABLED = "true";
process.env.VOICE_WORKER_API_TOKEN = "worker-test-token";
process.env.VOICE_LEASE_SIGNING_KEY = "voice-test-signing-key";
const db = new PrismaClient({ datasourceUrl: databaseUrl });

beforeEach(async () => { await db.$executeRawUnsafe('TRUNCATE TABLE "ToolInvocation", "MediaControlIntent", "VoiceAdmission", "TranscriptSegment", "VoiceEvent", "VoiceLease", "VoiceParticipant", "VoiceSession", "Session", "User", "Call" CASCADE'); });
afterAll(() => db.$disconnect());
async function session() { const callId = `voice-${randomUUID()}`; await db.call.create({ data: { id: callId, provider: "BROWSER", isTest: true, fromNumber: "browser" } }); const created = await createVoiceSession({ requestId: `request-${callId}`, callId, callerParticipantId: "caller", language: "hinglish" }, db); await recordVoiceDispatch(created.id, "dispatch", db); return { callId, id: created.id }; }
const worker = "Bearer worker-test-token";

describe("voice session persistence", () => {
  it("serializes concurrent claims and preserves a deterministic lease replay", async () => {
    const item = await session();
    const [left, right] = await Promise.all([claimVoiceLease({ callId: item.callId, roomName: (await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } })).roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db), claimVoiceLease({ callId: item.callId, roomName: (await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } })).roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db)]);
    expect(left).toEqual(right); expect(left.agentEpoch).toBe(1); expect(await db.voiceLease.count()).toBe(1);
    expect((await db.voiceParticipant.findFirstOrThrow({ where: { sessionId: item.id, role: "AGENT" } })).identity).toBe(workerParticipantIdentity(item.callId));
  });
  it("fences stale epochs, binds caller segments, and deduplicates exact evidence", async () => {
    const item = await session(); const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } }); const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    await expect(renewVoiceLease(item.callId, 2, lease.token, db)).rejects.toMatchObject({ code: "LEASE_STALE" } satisfies Partial<VoiceError>);
    const event = { schemaVersion: 1 as const, eventId: "event-1", callId: item.callId, agentEpoch: 1, sourceSequence: 1, occurredAt: new Date().toISOString(), type: "transcript.final" as const, payload: { segmentId: "segment", revision: 1, speaker: "CALLER" as const, participantId: "caller", sequence: 1, text: "Need help", language: "hi" } };
    expect(await recordVoiceEvent(event, lease.token, db)).toMatchObject({ status: "committed" }); expect(await recordVoiceEvent(event, lease.token, db)).toMatchObject({ status: "duplicate" });
    await expect(recordVoiceEvent({ ...event, eventId: "skipped", sourceSequence: 3 }, lease.token, db)).rejects.toMatchObject({ code: "SEQUENCE_OUT_OF_ORDER" } satisfies Partial<VoiceError>);
    await expect(recordVoiceEvent({ ...event, eventId: "event-2", sourceSequence: 2, payload: { ...event.payload, participantId: workerParticipantIdentity(item.callId) } }, lease.token, db)).rejects.toMatchObject({ code: "PARTICIPANT_MISMATCH" } satisfies Partial<VoiceError>);
  });
  it("prepares opaque admissions and revocation creates durable remove intent", async () => {
    const item = await session(); const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } }); await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db); const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, name: "Operator", role: "AGENT" } }); const browser = await db.session.create({ data: { userId: user.id, tokenHash: "token-hash", expiresAt: new Date(Date.now() + 60_000) } }); await db.voiceSession.update({ where: { id: item.id }, data: { ownerUserId: user.id, ownerSessionId: browser.id } });
    const admission = await prepareBrowserAdmission({ callId: item.callId, userId: user.id, sessionId: browser.id, role: "OPERATOR_LISTENER", expectedAuthorizationVersion: 1 }, db);
    expect(admission.participantIdentity).toMatch(/^adm_/); await db.$transaction((tx) => revokeAdmissions(tx, { sessionId: browser.id, reason: "LOGOUT" }));
    expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: admission.id } })).toMatchObject({ state: "REVOKING", authorizationVersion: 2 }); expect(await db.mediaControlIntent.count({ where: { admissionId: admission.id, kind: "REMOVE" } })).toBe(1);
  });
  it("does not disclose context after an expired lease", async () => {
    const item = await session(); const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } }); const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db); await db.voiceLease.updateMany({ where: { sessionId: item.id }, data: { expiresAt: new Date(Date.now() - 1) } }); await expect(voiceContext(item.callId, lease.token, db)).rejects.toMatchObject({ code: "LEASE_EXPIRED" } satisfies Partial<VoiceError>);
  });
  it("stores a tool intent and returns the same receipt after a lost-response retry", async () => {
    const item = await session(); const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } }); const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    const arguments_ = { journey: "CONSUMER_COMPLAINT", callerConfirmation: "NEW", fields: { product: "Oil", purchaseArea: "Indore", issueCategory: "quality", description: "Leaking", productAvailable: true }, queue: { territory: "MP", language: "hi" } };
    const first = await invokeVoiceTool({ callId: item.callId, invocationId: "tool-1", agentEpoch: 1, name: "create_business_request", arguments: arguments_ }, lease.token, db);
    const replay = await invokeVoiceTool({ callId: item.callId, invocationId: "tool-1", agentEpoch: 1, name: "create_business_request", arguments: arguments_ }, lease.token, db);
    expect(replay).toEqual(first); expect(await db.toolInvocation.findFirstOrThrow({ where: { sessionId: item.id } })).toMatchObject({ status: "COMMITTED" });
  });
  it("replays an equal create request and rejects a changed request payload", async () => {
    const callId = `voice-${randomUUID()}`;
    await db.call.create({ data: { id: callId, provider: "BROWSER", isTest: true, fromNumber: "browser" } });
    const input = { requestId: "create-1", callId, callerParticipantId: "caller", language: "hi" };
    const first = await createVoiceSession(input, db);
    expect((await createVoiceSession(input, db)).id).toBe(first.id);
    await expect(createVoiceSession({ ...input, language: "en" }, db)).rejects.toMatchObject({ code: "CREATE_REQUEST_CONFLICT" } satisfies Partial<VoiceError>);
    expect(await db.voiceSession.count({ where: { callId } })).toBe(1);
  });
  it("persists a fatal terminal state and fences renewal", async () => {
    const item = await session(); const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } }); const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    await recordVoiceEvent({ schemaVersion: 1, eventId: "fatal", callId: item.callId, agentEpoch: 1, sourceSequence: 1, occurredAt: new Date().toISOString(), type: "agent.failed", payload: { code: "FATAL" } }, lease.token, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ state: "FAILED" });
    await expect(renewVoiceLease(item.callId, 1, lease.token, db)).rejects.toMatchObject({ code: "LEASE_STALE" } satisfies Partial<VoiceError>);
  });
  it("projects only the current transcript revision and rejects a forged flush watermark", async () => {
    const item = await session(); const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } }); const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    const event = (eventId: string, sourceSequence: number, revision: number, text: string) => ({ schemaVersion: 1 as const, eventId, callId: item.callId, agentEpoch: 1, sourceSequence, occurredAt: new Date().toISOString(), type: "transcript.final" as const, payload: { segmentId: "segment", revision, speaker: "CALLER" as const, participantId: "caller", sequence: 1, text, language: "hi" } });
    await recordVoiceEvent(event("one", 1, 1, "old"), lease.token, db);
    await recordVoiceEvent(event("two", 2, 2, "new"), lease.token, db);
    expect(await db.utterance.findFirstOrThrow({ where: { callId: item.callId, seq: 1 } })).toMatchObject({ text: "new" });
    await expect(recordVoiceEvent({ schemaVersion: 1, eventId: "flush", callId: item.callId, agentEpoch: 1, sourceSequence: 3, occurredAt: new Date().toISOString(), type: "transcript.flushed", payload: { lastSourceSequence: 999 } }, lease.token, db)).rejects.toMatchObject({ code: "FLUSH_WATERMARK_INVALID" } satisfies Partial<VoiceError>);
  });
});
