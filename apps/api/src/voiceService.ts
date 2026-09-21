import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, PrismaClient, createBusinessRequest, prisma } from "@msva/db";
import { CreateRequestInputSchema, type CreateRequestResult, type VoiceLease, type WorkerEvent } from "@msva/contracts";
import { markPostCallAssessmentDirty } from "./assessmentJobs.js";

const LEASE_MS = 30_000;
const REPLAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;
const CONNECTION_MS = 10_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const workerParticipantIdentity = (callId: string) => `msva-agent-${hash(callId).slice(0, 32)}`;
const stable = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;

export class VoiceError extends Error { constructor(readonly status: number, readonly code: string, message = "Voice service request denied") { super(message); } }
export type VerifiedBrowserClaims = Readonly<{ subject: string; room: string; roomJoin: boolean; publish: boolean; subscribe: boolean }>;
export type VoiceDb = PrismaClient | Prisma.TransactionClient;

function configured(): { workerToken: string; signingKey: string } {
  const workerToken = process.env.VOICE_WORKER_API_TOKEN;
  const signingKey = process.env.VOICE_LEASE_SIGNING_KEY;
  if (process.env.VOICE_ENABLED !== "true" || !workerToken || !signingKey) throw new VoiceError(503, "VOICE_DISABLED");
  return { workerToken, signingKey };
}
function tokenEquals(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(actual.slice(7).trim()); const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}
function leaseToken(sessionId: string, epoch: number): string {
  const { signingKey } = configured();
  return `v1.${epoch}.${createHmac("sha256", signingKey).update(`${sessionId}:${epoch}`).digest("base64url")}`;
}
function leaseResponse(sessionId: string, callId: string, epoch: number, expiresAt: Date): VoiceLease {
  return { callId, agentEpoch: epoch, expiresAt: expiresAt.toISOString(), token: leaseToken(sessionId, epoch) };
}
function prompt(language: string): string {
  return `You are Madhusudan support. Speak ${language === "hi" ? "Hindi" : language === "hinglish" ? "Hindi-English Hinglish" : "English"} clearly. Do not claim access to prior history, deliveries, account records, or staff actions unless the current call context proves it. You may only say a business request was recorded after create_business_request returns a receipt; label it as pending staff follow-up. Never promise resolution, callback timing, refund, stock, or human takeover.`;
}
function serializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.meta?.code === "40001");
}
async function serializable<T>(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) { if (attempt === 2 || !serializationFailure(error)) throw error; }
  }
  throw new VoiceError(503, "VOICE_RETRY_EXHAUSTED");
}
async function lockedSession(tx: VoiceDb, callId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "VoiceSession" WHERE "callId" = ${callId} FOR UPDATE`);
  const session = await tx.voiceSession.findFirst({ where: { callId }, include: { participants: true, lease: true } });
  if (!session) throw new VoiceError(404, "CALL_NOT_FOUND");
  return session;
}
async function lockedAdmission(tx: VoiceDb, participantIdentity: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "VoiceAdmission" WHERE "participantIdentity" = ${participantIdentity} FOR UPDATE`);
  const admission = await tx.voiceAdmission.findUnique({ where: { participantIdentity }, include: { voiceSession: true } });
  if (!admission) throw new VoiceError(403, "ADMISSION_DENIED");
  return admission;
}
function activeLease(session: Awaited<ReturnType<typeof lockedSession>>, token: string, now: Date) {
  if (!session.lease || !tokenEquals(`Bearer ${token}`, leaseToken(session.id, session.lease.agentEpoch)) || hash(token) !== session.lease.tokenHash) throw new VoiceError(401, "LEASE_INVALID");
  if (session.lease.expiresAt > now) return session.lease;
  throw new VoiceError(409, "LEASE_EXPIRED");
}
function authenticatedEventLease(session: Awaited<ReturnType<typeof lockedSession>>, token: string, now: Date) {
  if (!session.lease || !tokenEquals(`Bearer ${token}`, leaseToken(session.id, session.lease.agentEpoch)) || hash(token) !== session.lease.tokenHash) throw new VoiceError(401, "LEASE_INVALID");
  const cutoff = session.endedAt && session.endedAt < session.lease.expiresAt ? session.endedAt : session.lease.expiresAt;
  if (now.getTime() > cutoff.getTime() + REPLAY_MS) throw new VoiceError(409, "LEASE_EXPIRED");
  return { lease: session.lease, cutoff, hasAuthority: session.lease.expiresAt > now && session.state === "ACTIVE" && session.ownershipMode === "AI" };
}

export async function createVoiceSession(input: { requestId: string; callId: string; ownerUserId?: string; ownerSessionId?: string; language?: string; callerParticipantId: string }, db: PrismaClient = prisma) {
  const canonicalInput = stable(input); const requestHash = hash(canonicalInput); const roomName = `msva-${hash(`${input.callId}:${input.requestId}`).slice(0, 24)}`; const dispatchIntentId = randomUUID();
  return serializable(db, async (tx) => {
    const replay = await tx.voiceSession.findUnique({ where: { createRequestId: input.requestId } });
    if (replay) { if (replay.createRequestHash !== requestHash) throw new VoiceError(409, "CREATE_REQUEST_CONFLICT"); return replay; }
    const call = await tx.call.findUnique({ where: { id: input.callId }, select: { id: true } }); if (!call) throw new VoiceError(404, "CALL_NOT_FOUND");
    await tx.voiceSession.updateMany({ where: { state: "STARTING", expiresAt: { lte: new Date() } }, data: { state: "FAILED", endedAt: new Date() } });
    const count = await tx.voiceSession.count({ where: { state: { in: ["STARTING", "ACTIVE"] } } }); if (count >= 2) throw new VoiceError(409, "ACTIVE_CAPACITY");
    return tx.voiceSession.create({ data: { callId: input.callId, roomName, ownerUserId: input.ownerUserId, ownerSessionId: input.ownerSessionId, createRequestId: input.requestId, createRequestHash: requestHash, dispatchIntentId, state: "STARTING", expiresAt: new Date(Date.now() + 60_000), language: input.language ?? "hi", prompt: prompt(input.language ?? "hi"), participants: { create: [{ identity: input.callerParticipantId, role: "CALLER" }, { identity: workerParticipantIdentity(input.callId), role: "AGENT" }] } } });
  });
}

export async function recordVoiceDispatch(sessionId: string, providerDispatchId: string, db: PrismaClient = prisma) {
  return db.voiceSession.update({ where: { id: sessionId }, data: { providerDispatchId } });
}

export async function claimVoiceLease(input: { callId: string; roomName: string; dispatchId: string; participantId: string }, authorization: string | undefined, db: PrismaClient = prisma, now = new Date()): Promise<VoiceLease> {
  const { workerToken } = configured(); if (!tokenEquals(authorization, workerToken)) throw new VoiceError(401, "WORKER_UNAUTHORIZED");
  const claimed = await serializable(db, async (tx) => {
    const session = await lockedSession(tx, input.callId);
    const checkedAt = new Date();
    const agent = session.participants.find((p) => p.identity === input.participantId && p.role === "AGENT");
    if (!agent || session.roomName !== input.roomName) throw new VoiceError(403, "DISPATCH_MISMATCH");
    if (!session.providerDispatchId) throw new VoiceError(503, "DISPATCH_PENDING");
    if (session.providerDispatchId !== input.dispatchId) throw new VoiceError(403, "DISPATCH_MISMATCH");
    if (session.state === "ENDED" || session.state === "FAILED" || session.ownershipMode !== "AI") throw new VoiceError(409, "SESSION_UNAVAILABLE");
    if (session.lease) {
      if (session.lease.expiresAt <= checkedAt) { await tx.voiceSession.update({ where: { id: session.id }, data: { state: "RECOVERY_REQUIRED", authorizationVersion: { increment: 1 } } }); return null; }
      return leaseResponse(session.id, session.callId, session.lease.agentEpoch, session.lease.expiresAt);
    }
    const epoch = session.currentEpoch + 1; const expiresAt = new Date(checkedAt.getTime() + LEASE_MS); const token = leaseToken(session.id, epoch);
    await tx.voiceSession.update({ where: { id: session.id }, data: { currentEpoch: epoch, state: "ACTIVE", lease: { create: { agentEpoch: epoch, tokenHash: hash(token), expiresAt } } } });
    return leaseResponse(session.id, session.callId, epoch, expiresAt);
  });
  if (!claimed) throw new VoiceError(409, "RECOVERY_REQUIRED");
  return claimed;
}

export async function voiceContext(callId: string, token: string, db: PrismaClient = prisma, now = new Date()) {
  return serializable(db, async (tx) => {
    const session = await lockedSession(tx, callId);
    const lease = activeLease(session, token, new Date());
    if (session.state !== "ACTIVE" || session.ownershipMode !== "AI") throw new VoiceError(409, "SESSION_UNAVAILABLE");
    const caller = session.participants.find((participant) => participant.role === "CALLER");
    const agent = session.participants.find((participant) => participant.role === "AGENT");
    if (!caller || !agent) throw new VoiceError(503, "SESSION_INCOMPLETE");
    return { callId, roomName: session.roomName, agentEpoch: lease.agentEpoch, callerParticipantId: caller.identity, agentParticipantId: agent.identity, language: session.language, permittedTools: ["create_business_request"] as const, prompt: session.prompt };
  });
}

export async function renewVoiceLease(callId: string, epoch: number, token: string, db: PrismaClient = prisma, now = new Date()): Promise<VoiceLease> {
  return serializable(db, async (tx) => {
    const session = await lockedSession(tx, callId);
    const checkedAt = new Date();
    const lease = activeLease(session, token, checkedAt);
    if (lease.agentEpoch !== epoch || session.state !== "ACTIVE" || session.ownershipMode !== "AI") throw new VoiceError(409, "LEASE_STALE");
    const expiresAt = new Date(checkedAt.getTime() + LEASE_MS);
    await tx.voiceLease.update({ where: { id: lease.id }, data: { expiresAt, renewedAt: checkedAt } });
    return leaseResponse(session.id, callId, epoch, expiresAt);
  });
}

export async function recordVoiceEvent(event: WorkerEvent, token: string, db: PrismaClient = prisma, now = new Date()) {
  return serializable(db, async (tx) => {
    const session = await lockedSession(tx, event.callId);
    const checkedAt = new Date();
    const { lease, cutoff, hasAuthority } = authenticatedEventLease(session, token, checkedAt);
    if (lease.agentEpoch !== event.agentEpoch) throw new VoiceError(403, "EPOCH_MISMATCH");
    const occurredAt = new Date(event.occurredAt);
    const isFlush = event.type === "transcript.flushed";
    const latestAllowed = isFlush ? cutoff.getTime() + REPLAY_MS : cutoff.getTime() + CLOCK_SKEW_MS;
    if (!Number.isFinite(occurredAt.getTime())
      || occurredAt.getTime() < lease.createdAt.getTime() - CLOCK_SKEW_MS
      || occurredAt.getTime() > checkedAt.getTime() + CLOCK_SKEW_MS
      || occurredAt.getTime() > latestAllowed) throw new VoiceError(409, "EVENT_TIME_INVALID");
    const canonicalBody = stable(event); const bodyHash = hash(canonicalBody);
    const byId = await tx.voiceEvent.findUnique({ where: { sessionId_eventId: { sessionId: session.id, eventId: event.eventId } } });
    if (byId) { if (byId.bodyHash !== bodyHash) throw new VoiceError(409, "EVENT_CONFLICT"); return { eventId: event.eventId, status: "duplicate" as const }; }
    const bySequence = await tx.voiceEvent.findUnique({ where: { sessionId_agentEpoch_sourceSequence: { sessionId: session.id, agentEpoch: event.agentEpoch, sourceSequence: event.sourceSequence } } }); if (bySequence) throw new VoiceError(409, "SEQUENCE_CONFLICT");
    const watermark = await tx.voiceEvent.aggregate({ where: { sessionId: session.id, agentEpoch: event.agentEpoch }, _max: { sourceSequence: true } });
    if (event.sourceSequence !== (watermark._max.sourceSequence ?? 0) + 1) throw new VoiceError(409, "SEQUENCE_OUT_OF_ORDER");
    const caller = session.participants.find((p) => p.role === "CALLER"); const agent = session.participants.find((p) => p.role === "AGENT");
    if (event.type === "transcript.final") {
      const expected = event.payload.speaker === "CALLER" ? caller?.identity : event.payload.speaker === "AGENT" ? agent?.identity : undefined;
      if (!expected || expected !== event.payload.participantId) throw new VoiceError(403, "PARTICIPANT_MISMATCH");
      const revisions = await tx.transcriptSegment.findMany({ where: { sessionId: session.id, segmentId: event.payload.segmentId }, orderBy: { revision: "desc" } });
      const sameRevision = revisions.find((segment) => segment.revision === event.payload.revision);
      const immutableChanged = (segment: typeof revisions[number]) => segment.speaker !== event.payload.speaker
        || segment.participantId !== event.payload.participantId
        || segment.sequence !== event.payload.sequence;
      if (revisions.some(immutableChanged)) throw new VoiceError(409, "SEGMENT_IDENTITY_CONFLICT");
      if (sameRevision && (sameRevision.text !== event.payload.text
        || sameRevision.startMs !== (event.payload.startMs ?? null)
        || sameRevision.endMs !== (event.payload.endMs ?? null)
        || sameRevision.language !== event.payload.language)) throw new VoiceError(409, "SEGMENT_REVISION_CONFLICT");
      const sequenceOwner = await tx.transcriptSegment.findFirst({
        where: { sessionId: session.id, sequence: event.payload.sequence, segmentId: { not: event.payload.segmentId }, isCurrent: true }
      });
      if (sequenceOwner) throw new VoiceError(409, "SEGMENT_SEQUENCE_CONFLICT");
      const highestRevision = revisions[0]?.revision;
      const current = highestRevision === undefined || event.payload.revision > highestRevision;
      if (current) await tx.transcriptSegment.updateMany({ where: { sessionId: session.id, segmentId: event.payload.segmentId, isCurrent: true }, data: { isCurrent: false } });
      if (!sameRevision) await tx.transcriptSegment.create({ data: { sessionId: session.id, segmentId: event.payload.segmentId, revision: event.payload.revision, speaker: event.payload.speaker, participantId: event.payload.participantId, sequence: event.payload.sequence, text: event.payload.text, startMs: event.payload.startMs ?? null, endMs: event.payload.endMs ?? null, language: event.payload.language, isCurrent: current } });
      if (current) {
        const projection = await tx.utterance.findFirst({ where: { callId: event.callId, seq: event.payload.sequence } });
        if (projection) await tx.utterance.update({ where: { id: projection.id }, data: { speaker: event.payload.speaker, text: event.payload.text, atMs: event.payload.endMs ?? null } });
        else await tx.utterance.create({ data: { callId: event.callId, seq: event.payload.sequence, speaker: event.payload.speaker, text: event.payload.text, atMs: event.payload.endMs ?? null } });
        if (session.finalWatermark > 0) await tx.voiceSession.update({ where: { id: session.id }, data: { finalWatermark: 0 } });
        await markPostCallAssessmentDirty(tx, event.callId, checkedAt);
      }
    }
    if (event.type === "agent.ready" && event.payload.participantId !== agent?.identity) throw new VoiceError(403, "PARTICIPANT_MISMATCH");
    if (event.type === "control.ack") {
      const control = await tx.mediaControlIntent.findUnique({ where: { id: event.payload.controlId }, include: { admission: { select: { voiceSessionId: true } } } });
      if (!control || control.admission.voiceSessionId !== session.id) throw new VoiceError(409, "CONTROL_ACK_INVALID");
      if (hasAuthority && control.status === "RUNNING") await tx.mediaControlIntent.update({ where: { id: control.id }, data: { status: "CONFIRMED", leaseExpiresAt: null } });
    }
    await tx.voiceEvent.create({ data: { sessionId: session.id, eventId: event.eventId, agentEpoch: event.agentEpoch, sourceSequence: event.sourceSequence, canonicalBody, bodyHash, type: event.type, occurredAt: new Date(event.occurredAt) } });
    if (event.type === "transcript.flushed") {
      if (event.payload.lastSourceSequence !== event.sourceSequence - 1 || event.payload.lastSourceSequence !== (watermark._max.sourceSequence ?? 0)) throw new VoiceError(409, "FLUSH_WATERMARK_INVALID");
      await tx.voiceSession.update({ where: { id: session.id }, data: { finalWatermark: event.payload.lastSourceSequence } });
    }
    if (event.type === "agent.failed" && event.payload.code === "FATAL" && hasAuthority) {
      await tx.voiceSession.update({ where: { id: session.id }, data: { state: "FAILED", endedAt: checkedAt, authorizationVersion: { increment: 1 } } });
      await tx.call.update({ where: { id: event.callId }, data: { status: "FAILED", endedAt: checkedAt, outcome: "ABANDONED" } });
      await revokeAdmissions(tx, { callId: event.callId, reason: "CALL_ENDED" }, checkedAt);
      await markPostCallAssessmentDirty(tx, event.callId, checkedAt);
    }
    return { eventId: event.eventId, status: "committed" as const };
  });
}

export async function finalizeVoiceSession(callId: string, db: PrismaClient = prisma): Promise<void> {
  await serializable(db, async (tx) => {
    const session = await lockedSession(tx, callId);
    const now = new Date();
    if (session.state === "ENDED" || session.state === "FAILED") return;
    const highest = await tx.voiceEvent.findFirst({ where: { sessionId: session.id, agentEpoch: session.currentEpoch }, orderBy: { sourceSequence: "desc" } });
    if (!highest || highest.type !== "transcript.flushed" || session.finalWatermark !== highest.sourceSequence - 1) throw new VoiceError(409, "EVIDENCE_INCOMPLETE");
    await tx.voiceSession.update({ where: { id: session.id }, data: { state: "ENDED", endedAt: now, authorizationVersion: { increment: 1 } } });
    await tx.call.update({ where: { id: callId }, data: { status: "COMPLETED", endedAt: now, outcome: "RESOLVED_BY_VA" } });
    await revokeAdmissions(tx, { callId, reason: "CALL_ENDED" }, now);
    await markPostCallAssessmentDirty(tx, callId, now);
  });
}

export async function invokeVoiceTool(input: { callId: string; invocationId: string; agentEpoch: number; name: "create_business_request"; arguments: unknown }, token: string, db: PrismaClient = prisma, now = new Date()): Promise<CreateRequestResult> {
  const prepared = await serializable(db, async (tx) => {
    const session = await lockedSession(tx, input.callId); const checkedAt = new Date(); const lease = activeLease(session, token, checkedAt);
    if (lease.agentEpoch !== input.agentEpoch || session.state !== "ACTIVE" || session.ownershipMode !== "AI") throw new VoiceError(409, "LEASE_STALE");
    const canonicalPayload = stable(input.arguments); const existing = await tx.toolInvocation.findUnique({ where: { sessionId_invocationId: { sessionId: session.id, invocationId: input.invocationId } } });
    if (existing) { if (existing.canonicalPayload !== canonicalPayload) throw new VoiceError(409, "INVOCATION_CONFLICT"); if (existing.status === "COMMITTED" && existing.result) return { result: existing.result as unknown as CreateRequestResult } as const; return { sessionId: session.id, canonicalPayload } as const; }
    await tx.toolInvocation.create({ data: { sessionId: session.id, invocationId: input.invocationId, agentEpoch: input.agentEpoch, name: input.name, canonicalPayload, payloadHash: hash(canonicalPayload), status: "PENDING" } });
    return { sessionId: session.id, canonicalPayload } as const;
  });
  if ("result" in prepared) { if (!prepared.result) throw new VoiceError(503, "TOOL_RECEIPT_UNAVAILABLE"); return prepared.result; }
  if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) throw new VoiceError(400, "INVALID_TOOL_ARGUMENTS");
  const command = { ...(input.arguments as Record<string, unknown>), callId: input.callId, requestId: `voice:${input.callId}:${input.invocationId}` };
  const parsed = CreateRequestInputSchema.safeParse(command); if (!parsed.success) throw new VoiceError(400, "INVALID_TOOL_ARGUMENTS");
  return serializable(db, async (tx) => {
    const session = await lockedSession(tx, input.callId); const checkedAt = new Date(); const lease = activeLease(session, token, checkedAt);
    if (lease.agentEpoch !== input.agentEpoch || session.state !== "ACTIVE" || session.ownershipMode !== "AI") throw new VoiceError(409, "LEASE_STALE");
    const existing = await tx.toolInvocation.findUniqueOrThrow({ where: { sessionId_invocationId: { sessionId: session.id, invocationId: input.invocationId } } });
    if (existing.canonicalPayload !== prepared.canonicalPayload) throw new VoiceError(409, "INVOCATION_CONFLICT");
    if (existing.status === "COMMITTED" && existing.result) return existing.result as unknown as CreateRequestResult;
    const result = await createBusinessRequest(tx, parsed.data);
    await tx.toolInvocation.update({ where: { id: existing.id }, data: { status: "COMMITTED", result: result as unknown as Prisma.InputJsonValue } });
    return result;
  });
}

export async function voiceToolReceipt(callId: string, invocationId: string, token: string, db: PrismaClient = prisma, now = new Date()): Promise<CreateRequestResult> {
  return serializable(db, async (tx) => {
    const session = await lockedSession(tx, callId);
    const checkedAt = new Date();
    if (!session.lease || !tokenEquals(`Bearer ${token}`, leaseToken(session.id, session.lease.agentEpoch)) || hash(token) !== session.lease.tokenHash || checkedAt.getTime() > session.lease.expiresAt.getTime() + REPLAY_MS) throw new VoiceError(409, "LEASE_EXPIRED");
    const invocation = await tx.toolInvocation.findUnique({ where: { sessionId_invocationId: { sessionId: session.id, invocationId } } });
    if (!invocation || invocation.status !== "COMMITTED" || !invocation.result) throw new VoiceError(404, "TOOL_RECEIPT_NOT_FOUND");
    return invocation.result as unknown as CreateRequestResult;
  });
}

export async function prepareBrowserAdmission(input: { callId: string; userId: string; sessionId: string; role: "CALLER" | "OPERATOR_LISTENER" | "OPERATOR_SPEAKER"; expectedAuthorizationVersion: number }, db: PrismaClient = prisma, now = new Date()) {
  return serializable(db, async (tx) => {
    const session = await lockedSession(tx, input.callId);
    const checkedAt = new Date();
    const browser = await tx.session.findFirst({ where: { id: input.sessionId, userId: input.userId, expiresAt: { gt: checkedAt }, user: { active: true } }, include: { user: true } });
    if (!browser || session.authorizationVersion !== input.expectedAuthorizationVersion || session.state !== "ACTIVE") throw new VoiceError(403, "ADMISSION_DENIED");
    const callerOwnsSession = session.ownerUserId === input.userId && session.ownerSessionId === input.sessionId;
    const assignedOperator = await tx.handoff.findFirst({ where: { callId: input.callId, assignedUserId: input.userId, state: { in: ["ASSIGNED", "JOINING", "HUMAN_ACTIVE"] } } });
    const operatorAllowed = browser.user.role !== "VIEWER" && Boolean(assignedOperator);
    if ((input.role === "CALLER" && !callerOwnsSession) || (input.role !== "CALLER" && !operatorAllowed)) throw new VoiceError(403, "ADMISSION_DENIED");
    if (input.role === "OPERATOR_SPEAKER" && (session.ownershipMode !== "HUMAN" || !assignedOperator || assignedOperator.state !== "HUMAN_ACTIVE")) throw new VoiceError(403, "ADMISSION_DENIED");
    const caller = session.participants.find((participant) => participant.role === "CALLER");
    if (input.role === "CALLER" && !caller) throw new VoiceError(503, "SESSION_INCOMPLETE");
    const existing = await tx.voiceAdmission.findFirst({ where: { voiceSessionId: session.id, sessionId: input.sessionId, userId: input.userId, role: input.role, state: { in: ["ISSUED", "CONNECTING", "ACTIVE"] } } });
    if (existing) return existing;
    if (input.role === "CALLER") {
      const occupied = await tx.voiceAdmission.findFirst({ where: { voiceSessionId: session.id, role: "CALLER", state: { in: ["ISSUED", "CONNECTING", "ACTIVE"] } } });
      if (occupied) throw new VoiceError(409, "CALLER_ADMISSION_EXISTS");
    }
    const absolute = new Date(Math.min(checkedAt.getTime() + 2 * 60 * 60 * 1000, browser.expiresAt.getTime()));
    return tx.voiceAdmission.create({ data: { callId: input.callId, voiceSessionId: session.id, sessionId: input.sessionId, userId: input.userId, participantIdentity: input.role === "CALLER" ? caller!.identity : `adm_${randomUUID()}`, role: input.role, authorizationVersion: session.authorizationVersion, firstJoinExpiresAt: new Date(checkedAt.getTime() + 60_000), absoluteExpiresAt: absolute } });
  });
}

export async function revokeAdmissions(tx: Prisma.TransactionClient, input: { sessionId?: string; userId?: string; callId?: string; reason: "LOGOUT" | "USER_DISABLED" | "SESSION_EXPIRED" | "OWNERSHIP_CHANGED" | "CALL_ENDED" | "CONTROL_LOST" }, now = new Date()): Promise<void> {
  if (!input.sessionId && !input.userId && !input.callId) throw new VoiceError(400, "REVOCATION_SCOPE_REQUIRED");
  const admissions = await tx.voiceAdmission.findMany({ where: { ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.userId ? { userId: input.userId } : {}), ...(input.callId ? { callId: input.callId } : {}), state: { in: ["ISSUED", "CONNECTING", "ACTIVE"] } } });
  for (const admission of admissions) {
    const version = admission.authorizationVersion + 1;
    const revoked = await tx.voiceAdmission.updateMany({ where: { id: admission.id, authorizationVersion: admission.authorizationVersion, state: { in: ["ISSUED", "CONNECTING", "ACTIVE"] } }, data: { state: "REVOKING", authorizationVersion: version, revokedAt: now, revokeReason: input.reason, connectionLeaseExpiresAt: now, connectionOwner: null } });
    if (revoked.count !== 1) continue;
    await tx.mediaControlIntent.updateMany({ where: { admissionId: admission.id, kind: "GRANT", status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", errorCode: "REVOKED", leaseExpiresAt: null } });
    await tx.mediaControlIntent.create({ data: { admissionId: admission.id, authorizationVersion: version, kind: "REMOVE" } });
  }
}

export async function authorizeSignalConnection(input: { tokenClaims: VerifiedBrowserClaims; sessionTokenHash: string; origin: string; protocol: "v0" | "v1"; reconnect: boolean; participantSid: string | null; now: Date }, db: PrismaClient = prisma) {
  // This is intentionally an internal, post-verifier primitive. No HTTP route accepts claims.
  return serializable(db, async (tx) => {
    const now = new Date();
    const admission = await lockedAdmission(tx, input.tokenClaims.subject);
    const session = admission.voiceSession;
    const expectedOrigin = process.env.VOICE_BROWSER_ORIGIN;
    const canPublish = admission.role !== "OPERATOR_LISTENER";
    if (!expectedOrigin || input.origin !== expectedOrigin || input.protocol !== "v1"
      || !input.tokenClaims.roomJoin || !input.tokenClaims.subscribe
      || (input.tokenClaims.publish && !canPublish)
      || session.roomName !== input.tokenClaims.room || session.state !== "ACTIVE"
      || admission.state === "REVOKING" || admission.state === "REVOKED" || admission.state === "EXPIRED"
      || admission.absoluteExpiresAt <= now || (admission.state === "ISSUED" && admission.firstJoinExpiresAt <= now)) throw new VoiceError(403, "ADMISSION_DENIED");
    const browser = await tx.session.findFirst({ where: { id: admission.sessionId, userId: admission.userId, tokenHash: input.sessionTokenHash, expiresAt: { gt: now }, user: { active: true } } });
    const callerAuthorized = admission.role === "CALLER" && session.ownerUserId === admission.userId && session.ownerSessionId === admission.sessionId;
    const assignment = admission.role === "CALLER" ? null : await tx.handoff.findFirst({ where: { callId: admission.callId, assignedUserId: admission.userId, state: admission.role === "OPERATOR_SPEAKER" ? "HUMAN_ACTIVE" : { in: ["ASSIGNED", "JOINING", "HUMAN_ACTIVE"] } } });
    const operatorAuthorized = admission.role !== "CALLER" && Boolean(assignment) && (admission.role !== "OPERATOR_SPEAKER" || session.ownershipMode === "HUMAN");
    if (!browser || !(callerAuthorized || operatorAuthorized) || admission.authorizationVersion !== session.authorizationVersion) throw new VoiceError(403, "ADMISSION_DENIED");
    if (admission.connectionLeaseExpiresAt && admission.connectionLeaseExpiresAt > now) throw new VoiceError(409, "CONNECTION_ACTIVE");
    if (!input.reconnect && input.participantSid) throw new VoiceError(403, "INITIAL_SID_FORBIDDEN");
    if (input.reconnect && (!input.participantSid || admission.participantSid !== input.participantSid)) throw new VoiceError(403, "RECONNECT_MISMATCH");
    const epoch = admission.connectionEpoch + 1;
    const until = new Date(now.getTime() + CONNECTION_MS);
    const owner = randomUUID();
    await tx.voiceAdmission.update({ where: { id: admission.id }, data: { connectionEpoch: epoch, connectionOwner: owner, connectionLeaseExpiresAt: until, lastAuthorizedAt: now, state: "CONNECTING" } });
    return { admissionId: admission.id, callId: admission.callId, participantIdentity: admission.participantIdentity, authorizationVersion: admission.authorizationVersion, connectionEpoch: epoch, connectionOwner: owner, connectionLeaseExpiresAt: until };
  });
}

export async function renewSignalConnection(input: { admissionId: string; connectionEpoch: number; connectionOwner: string }, db: PrismaClient = prisma) {
  return serializable(db, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "VoiceAdmission" WHERE "id" = ${input.admissionId} FOR UPDATE`);
    const admission = await tx.voiceAdmission.findUniqueOrThrow({ where: { id: input.admissionId }, include: { voiceSession: true } });
    const now = new Date();
    if (admission.connectionEpoch !== input.connectionEpoch || admission.connectionOwner !== input.connectionOwner || !admission.connectionLeaseExpiresAt || admission.connectionLeaseExpiresAt <= now || admission.voiceSession.state !== "ACTIVE" || admission.authorizationVersion !== admission.voiceSession.authorizationVersion) throw new VoiceError(409, "CONNECTION_STALE");
    const connectionLeaseExpiresAt = new Date(now.getTime() + CONNECTION_MS);
    await tx.voiceAdmission.update({ where: { id: admission.id }, data: { connectionLeaseExpiresAt, lastAuthorizedAt: now, state: "ACTIVE" } });
    return { connectionLeaseExpiresAt };
  });
}

export async function releaseSignalConnection(input: { admissionId: string; connectionEpoch: number; connectionOwner: string }, db: PrismaClient = prisma): Promise<void> {
  await serializable(db, async (tx) => {
    const released = await tx.voiceAdmission.updateMany({ where: { id: input.admissionId, connectionEpoch: input.connectionEpoch, connectionOwner: input.connectionOwner, state: { in: ["CONNECTING", "ACTIVE"] } }, data: { connectionOwner: null, connectionLeaseExpiresAt: new Date() } });
    if (released.count !== 1) throw new VoiceError(409, "CONNECTION_STALE");
  });
}

/** Claims one durable media instruction for a gateway worker. The attempt token
 * fences a late adapter response after revocation or watchdog recovery. */
export async function claimMediaControlIntent(db: PrismaClient = prisma) {
  return serializable(db, async (tx) => {
    const candidate = await tx.mediaControlIntent.findFirst({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, include: { admission: { include: { voiceSession: true } } } });
    if (!candidate) return null;
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MediaControlIntent" WHERE "id" = ${candidate.id} FOR UPDATE`);
    const current = await tx.mediaControlIntent.findUniqueOrThrow({ where: { id: candidate.id }, include: { admission: { include: { voiceSession: true } } } });
    if (current.status !== "PENDING") return null;
    const validGrant = current.kind !== "GRANT" || (current.admission.state !== "REVOKING" && current.admission.state !== "REVOKED" && current.admission.authorizationVersion === current.authorizationVersion && current.admission.voiceSession.authorizationVersion === current.authorizationVersion);
    if (!validGrant) {
      await tx.mediaControlIntent.update({ where: { id: current.id }, data: { status: "FAILED", errorCode: "REVOKED" } });
      return null;
    }
    const attemptToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + CONNECTION_MS);
    await tx.mediaControlIntent.update({ where: { id: current.id }, data: { status: "RUNNING", attemptToken, leaseExpiresAt } });
    return { id: current.id, admissionId: current.admissionId, authorizationVersion: current.authorizationVersion, kind: current.kind, attemptToken, leaseExpiresAt };
  });
}

export async function finishMediaControlIntent(input: { id: string; attemptToken: string; success: boolean; errorCode?: string }, db: PrismaClient = prisma): Promise<void> {
  await serializable(db, async (tx) => {
    const intent = await tx.mediaControlIntent.findUnique({ where: { id: input.id }, include: { admission: true } });
    if (!intent || intent.status !== "RUNNING" || intent.attemptToken !== input.attemptToken) throw new VoiceError(409, "CONTROL_ATTEMPT_STALE");
    if (input.success && intent.kind === "GRANT" && (intent.admission.state === "REVOKING" || intent.admission.state === "REVOKED" || intent.admission.authorizationVersion !== intent.authorizationVersion)) throw new VoiceError(409, "CONTROL_ATTEMPT_STALE");
    await tx.mediaControlIntent.update({ where: { id: intent.id }, data: { status: input.success ? "CONFIRMED" : "FAILED", errorCode: input.success ? null : input.errorCode ?? "ADAPTER_FAILED", leaseExpiresAt: null } });
  });
}
