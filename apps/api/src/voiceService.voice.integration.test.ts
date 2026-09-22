import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@msva/db";
import { authorizeSignalConnection, claimMediaControlIntent, claimVoiceLease, createVoiceSession, finalizeVoiceSession, finishMediaControlIntent, invokeVoiceTool, prepareBrowserAdmission, recordVoiceDispatch, recordVoiceEvent, releaseSignalConnection, renewSignalConnection, renewVoiceLease, revokeAdmissions, VoiceError, voiceContext, workerParticipantIdentity } from "./voiceService.js";

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
    const item = await session(); const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } }); await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db); const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, name: "Operator", role: "AGENT" } }); const browser = await db.session.create({ data: { userId: user.id, tokenHash: "token-hash", expiresAt: new Date(Date.now() + 60_000) } }); await db.voiceSession.update({ where: { id: item.id }, data: { ownerUserId: user.id, ownerSessionId: browser.id } }); await db.handoff.create({ data: { callId: item.callId, assignedUserId: user.id, state: "ASSIGNED" } });
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
  it("reclaims expired startup capacity before rejecting a new create", async () => {
    const createStarting = async (suffix: string) => {
      const callId = `voice-${suffix}-${randomUUID()}`;
      await db.call.create({ data: { id: callId, provider: "BROWSER", isTest: true, fromNumber: "browser" } });
      return createVoiceSession({ requestId: `request-${callId}`, callId, callerParticipantId: `caller-${suffix}` }, db);
    };
    const first = await createStarting("one");
    await createStarting("two");
    await expect(createStarting("three")).rejects.toMatchObject({ code: "ACTIVE_CAPACITY" } satisfies Partial<VoiceError>);
    await db.voiceSession.update({ where: { id: first.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    await expect(createStarting("three-retry")).resolves.toMatchObject({ state: "STARTING" });
  });
  it("hands a live call to staff recovery on a worker failure and fences renewal", async () => {
    const item = await session(); const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } }); const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    await recordVoiceEvent({ schemaVersion: 1, eventId: "fatal", callId: item.callId, agentEpoch: 1, sourceSequence: 1, occurredAt: new Date().toISOString(), type: "agent.failed", payload: { code: "FATAL" } }, lease.token, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ state: "RECOVERY_REQUIRED" });
    expect(await db.call.findUniqueOrThrow({ where: { id: item.callId } })).toMatchObject({ status: "IN_PROGRESS", endedAt: null });
    await expect(renewVoiceLease(item.callId, 1, lease.token, db)).rejects.toMatchObject({ code: "LEASE_EXPIRED" } satisfies Partial<VoiceError>);
  });
  it("projects only the current transcript revision and rejects a forged flush watermark", async () => {
    const item = await session(); const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } }); const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    const event = (eventId: string, sourceSequence: number, revision: number, text: string) => ({ schemaVersion: 1 as const, eventId, callId: item.callId, agentEpoch: 1, sourceSequence, occurredAt: new Date().toISOString(), type: "transcript.final" as const, payload: { segmentId: "segment", revision, speaker: "CALLER" as const, participantId: "caller", sequence: 1, text, language: "hi" } });
    await recordVoiceEvent(event("one", 1, 1, "old"), lease.token, db);
    await recordVoiceEvent(event("two", 2, 2, "new"), lease.token, db);
    expect(await db.utterance.findFirstOrThrow({ where: { callId: item.callId, seq: 1 } })).toMatchObject({ text: "new" });
    await expect(recordVoiceEvent({ schemaVersion: 1, eventId: "flush", callId: item.callId, agentEpoch: 1, sourceSequence: 3, occurredAt: new Date().toISOString(), type: "transcript.flushed", payload: { lastSourceSequence: 999 } }, lease.token, db)).rejects.toMatchObject({ code: "FLUSH_WATERMARK_INVALID" } satisfies Partial<VoiceError>);
  });
  it("drains ready, final, and flush in one strict live stream and invalidates an old checkpoint", async () => {
    const item = await session();
    const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } });
    const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    const at = new Date().toISOString();
    await recordVoiceEvent({ schemaVersion: 1, eventId: "ready-1", callId: item.callId, agentEpoch: 1, sourceSequence: 1, occurredAt: at, type: "agent.ready", payload: { participantId: workerParticipantIdentity(item.callId) } }, lease.token, db);
    await recordVoiceEvent({ schemaVersion: 1, eventId: "final-2", callId: item.callId, agentEpoch: 1, sourceSequence: 2, occurredAt: at, type: "transcript.final", payload: { segmentId: "segment", revision: 1, speaker: "CALLER", participantId: "caller", sequence: 1, text: "first", language: "hi" } }, lease.token, db);
    await recordVoiceEvent({ schemaVersion: 1, eventId: "flush-3", callId: item.callId, agentEpoch: 1, sourceSequence: 3, occurredAt: at, type: "transcript.flushed", payload: { lastSourceSequence: 2 } }, lease.token, db);
    expect((await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } })).finalWatermark).toBe(2);
    await recordVoiceEvent({ schemaVersion: 1, eventId: "revision-4", callId: item.callId, agentEpoch: 1, sourceSequence: 4, occurredAt: at, type: "transcript.final", payload: { segmentId: "segment", revision: 2, speaker: "CALLER", participantId: "caller", sequence: 1, text: "revised", language: "hi" } }, lease.token, db);
    expect((await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } })).finalWatermark).toBe(0);
    // The call can end with the checkpoint invalidated; completeness is recorded, and the next checkpoint restores it.
    await finalizeVoiceSession(item.callId, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ state: "ENDED", transcriptComplete: false });
    await recordVoiceEvent({ schemaVersion: 1, eventId: "flush-5", callId: item.callId, agentEpoch: 1, sourceSequence: 5, occurredAt: at, type: "transcript.flushed", payload: { lastSourceSequence: 4 } }, lease.token, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ state: "ENDED", transcriptComplete: true });
    // Caller speech without a recorded request is not evidence of resolution.
    const ended = await db.call.findUniqueOrThrow({ where: { id: item.callId } });
    expect(ended).toMatchObject({ status: "COMPLETED", outcome: "IN_PROGRESS" });
    expect(ended.durationMs).not.toBeNull();
  });
  it("accepts retained expired ready, final, and flush as evidence without restoring authority", async () => {
    const item = await session();
    const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } });
    const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    await db.voiceLease.updateMany({ where: { sessionId: item.id }, data: { expiresAt: new Date(Date.now() - 500) } });
    const at = new Date().toISOString();
    await recordVoiceEvent({ schemaVersion: 1, eventId: "expired-ready", callId: item.callId, agentEpoch: 1, sourceSequence: 1, occurredAt: at, type: "agent.ready", payload: { participantId: workerParticipantIdentity(item.callId) } }, lease.token, db);
    await recordVoiceEvent({ schemaVersion: 1, eventId: "expired-final", callId: item.callId, agentEpoch: 1, sourceSequence: 2, occurredAt: at, type: "transcript.final", payload: { segmentId: "offline", revision: 1, speaker: "CALLER", participantId: "caller", sequence: 1, text: "offline evidence", language: "hi" } }, lease.token, db);
    await recordVoiceEvent({ schemaVersion: 1, eventId: "expired-flush", callId: item.callId, agentEpoch: 1, sourceSequence: 3, occurredAt: at, type: "transcript.flushed", payload: { lastSourceSequence: 2 } }, lease.token, db);
    expect(await db.voiceEvent.count({ where: { sessionId: item.id } })).toBe(3);
    expect((await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } })).state).toBe("ACTIVE");
    await expect(renewVoiceLease(item.callId, 1, lease.token, db)).rejects.toMatchObject({ code: "LEASE_EXPIRED" } satisfies Partial<VoiceError>);
  });
  it("records an old fatal as evidence but never reopens or fences terminal human ownership", async () => {
    const item = await session();
    const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } });
    const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    const endedAt = new Date();
    await db.voiceSession.update({ where: { id: item.id }, data: { state: "ENDED", ownershipMode: "HUMAN", endedAt } });
    await db.voiceLease.updateMany({ where: { sessionId: item.id }, data: { expiresAt: new Date(Date.now() - 500) } });
    await recordVoiceEvent({ schemaVersion: 1, eventId: "old-fatal", callId: item.callId, agentEpoch: 1, sourceSequence: 1, occurredAt: endedAt.toISOString(), type: "agent.failed", payload: { code: "FATAL" } }, lease.token, db);
    expect(await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ state: "ENDED", ownershipMode: "HUMAN" });
    expect(await db.call.findUniqueOrThrow({ where: { id: item.callId } })).not.toMatchObject({ status: "FAILED" });
  });
  it("rejects human impersonation, changed equal revisions, and cross-segment projection overwrite", async () => {
    const item = await session();
    const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } });
    const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    const at = new Date().toISOString();
    await expect(recordVoiceEvent({ schemaVersion: 1, eventId: "human", callId: item.callId, agentEpoch: 1, sourceSequence: 1, occurredAt: at, type: "transcript.final", payload: { segmentId: "human", revision: 1, speaker: "HUMAN", participantId: "operator", sequence: 1, text: "forged", language: "hi" } }, lease.token, db)).rejects.toMatchObject({ code: "PARTICIPANT_MISMATCH" } satisfies Partial<VoiceError>);
    await recordVoiceEvent({ schemaVersion: 1, eventId: "segment-a", callId: item.callId, agentEpoch: 1, sourceSequence: 1, occurredAt: at, type: "transcript.final", payload: { segmentId: "a", revision: 1, speaker: "CALLER", participantId: "caller", sequence: 1, text: "original", language: "hi" } }, lease.token, db);
    await expect(recordVoiceEvent({ schemaVersion: 1, eventId: "same-revision-different-body", callId: item.callId, agentEpoch: 1, sourceSequence: 2, occurredAt: at, type: "transcript.final", payload: { segmentId: "a", revision: 1, speaker: "CALLER", participantId: "caller", sequence: 1, text: "mutated", language: "hi" } }, lease.token, db)).rejects.toMatchObject({ code: "SEGMENT_REVISION_CONFLICT" } satisfies Partial<VoiceError>);
    await expect(recordVoiceEvent({ schemaVersion: 1, eventId: "other-segment-same-order", callId: item.callId, agentEpoch: 1, sourceSequence: 2, occurredAt: at, type: "transcript.final", payload: { segmentId: "b", revision: 1, speaker: "CALLER", participantId: "caller", sequence: 1, text: "overwrite", language: "hi" } }, lease.token, db)).rejects.toMatchObject({ code: "SEGMENT_SEQUENCE_CONFLICT" } satisfies Partial<VoiceError>);
    expect(await db.utterance.findFirstOrThrow({ where: { callId: item.callId, seq: 1 } })).toMatchObject({ text: "original" });
  });
  it("rejects future and beyond-retention evidence even with an authentic token", async () => {
    const item = await session();
    const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } });
    const lease = await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    await expect(recordVoiceEvent({ schemaVersion: 1, eventId: "future", callId: item.callId, agentEpoch: 1, sourceSequence: 1, occurredAt: new Date(Date.now() + 6_000).toISOString(), type: "agent.ready", payload: { participantId: workerParticipantIdentity(item.callId) } }, lease.token, db)).rejects.toMatchObject({ code: "EVENT_TIME_INVALID" } satisfies Partial<VoiceError>);
    await db.voiceLease.updateMany({ where: { sessionId: item.id }, data: { expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000 - 1) } });
    await expect(recordVoiceEvent({ schemaVersion: 1, eventId: "too-old", callId: item.callId, agentEpoch: 1, sourceSequence: 1, occurredAt: new Date().toISOString(), type: "agent.ready", payload: { participantId: workerParticipantIdentity(item.callId) } }, lease.token, db)).rejects.toMatchObject({ code: "LEASE_EXPIRED" } satisfies Partial<VoiceError>);
  });
  it("revalidates caller admission after reservation and fences connection owners", async () => {
    process.env.VOICE_BROWSER_ORIGIN = "https://console.test";
    const item = await session();
    const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } });
    await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, name: "Caller", role: "AGENT" } });
    const browser = await db.session.create({ data: { userId: user.id, tokenHash: "caller-token", expiresAt: new Date(Date.now() + 60_000) } });
    await db.voiceSession.update({ where: { id: item.id }, data: { ownerUserId: user.id, ownerSessionId: browser.id } });
    await db.handoff.create({ data: { callId: item.callId, assignedUserId: user.id, state: "ASSIGNED" } });
    const admission = await prepareBrowserAdmission({ callId: item.callId, userId: user.id, sessionId: browser.id, role: "CALLER", expectedAuthorizationVersion: 1 }, db);
    const input = { tokenClaims: { subject: admission.participantIdentity, room: row.roomName, roomJoin: true, publish: false, subscribe: false }, sessionTokenHash: "caller-token", origin: "https://console.test", protocol: "v1" as const, reconnect: false, participantSid: null };
    await expect(authorizeSignalConnection({ ...input, participantSid: "forged-sid" }, db)).rejects.toMatchObject({ code: "INITIAL_SID_FORBIDDEN" } satisfies Partial<VoiceError>);
    const connection = await authorizeSignalConnection(input, db);
    await renewSignalConnection({ admissionId: connection.admissionId, connectionEpoch: connection.connectionEpoch, connectionOwner: connection.connectionOwner }, db);
    await releaseSignalConnection({ admissionId: connection.admissionId, connectionEpoch: connection.connectionEpoch, connectionOwner: connection.connectionOwner }, db);
    await expect(renewSignalConnection({ admissionId: connection.admissionId, connectionEpoch: connection.connectionEpoch, connectionOwner: connection.connectionOwner }, db)).rejects.toMatchObject({ code: "CONNECTION_STALE" } satisfies Partial<VoiceError>);
    await db.voiceSession.update({ where: { id: item.id }, data: { state: "FAILED" } });
    await expect(authorizeSignalConnection(input, db)).rejects.toMatchObject({ code: "ADMISSION_DENIED" } satisfies Partial<VoiceError>);
  });
  it("revokes grants with a single remove intent under concurrent callers", async () => {
    const item = await session();
    const row = await db.voiceSession.findUniqueOrThrow({ where: { id: item.id } });
    await claimVoiceLease({ callId: item.callId, roomName: row.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(item.callId) }, worker, db);
    const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, name: "Operator", role: "AGENT" } });
    const browser = await db.session.create({ data: { userId: user.id, tokenHash: "token-hash", expiresAt: new Date(Date.now() + 60_000) } });
    await db.voiceSession.update({ where: { id: item.id }, data: { ownerUserId: user.id, ownerSessionId: browser.id } });
    await db.handoff.create({ data: { callId: item.callId, assignedUserId: user.id, state: "ASSIGNED" } });
    const admission = await prepareBrowserAdmission({ callId: item.callId, userId: user.id, sessionId: browser.id, role: "OPERATOR_LISTENER", expectedAuthorizationVersion: 1 }, db);
    // A grant is only for a participant whose connection is confirmed and live.
    await db.voiceAdmission.update({ where: { id: admission.id }, data: { state: "ACTIVE", participantSid: "PA_operator", connectionLeaseExpiresAt: new Date(Date.now() + 10_000) } });
    await db.mediaControlIntent.create({ data: { admissionId: admission.id, authorizationVersion: 1, kind: "GRANT" } });
    const claimed = await claimMediaControlIntent(db);
    expect(claimed).toMatchObject({ admissionId: admission.id, kind: "GRANT" });
    await Promise.all([db.$transaction((tx) => revokeAdmissions(tx, { callId: item.callId, reason: "CALL_ENDED" })), db.$transaction((tx) => revokeAdmissions(tx, { callId: item.callId, reason: "CALL_ENDED" }))]);
    expect(await db.mediaControlIntent.count({ where: { admissionId: admission.id, kind: "REMOVE" } })).toBe(1);
    // The in-flight grant keeps its attempt lease, so the REMOVE waits behind it.
    expect(await db.mediaControlIntent.findFirstOrThrow({ where: { admissionId: admission.id, kind: "GRANT" } })).toMatchObject({ status: "RUNNING", errorCode: "REVOKED" });
    expect(await claimMediaControlIntent(db)).toBeNull();
    await finishMediaControlIntent({ id: claimed!.id, attemptToken: claimed!.attemptToken, success: true }, db);
    expect(await db.mediaControlIntent.findFirstOrThrow({ where: { admissionId: admission.id, kind: "GRANT" } })).toMatchObject({ status: "FAILED", errorCode: "REVOKED" });
    const removal = await claimMediaControlIntent(db);
    expect(removal).toMatchObject({ admissionId: admission.id, kind: "REMOVE" });
    await finishMediaControlIntent({ id: removal!.id, attemptToken: removal!.attemptToken, success: true }, db);
    expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: admission.id } })).toMatchObject({ state: "REVOKED" });
  });
});
