import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { DemoRequestError, Prisma, PrismaClient, createBusinessRequest, prisma, type CallOutcome } from "@msva/db";
import { CreateRequestInputSchema, type CreateRequestResult, type VoiceLease, type WorkerEvent } from "@msva/contracts";
import { markPostCallAssessmentDirty } from "./assessmentJobs.js";

const LEASE_MS = 30_000;
const REPLAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;
const CONNECTION_MS = 10_000;
const STARTING_MS = 60_000;
const MAX_ACTIVE_SESSIONS = 2;
// Per-call ingestion bounds, so a runaway or compromised worker cannot grow the
// inbox without limit. 5,000 events over the two-hour admission window is one
// event every 1.44 s.
const MAX_SESSION_EVENTS = 5_000;
const MAX_SESSION_EVENT_BYTES = 8 * 1024 * 1024;
// A call that lost its AI and that nobody ended is closed once it has waited
// this long with nobody still admitted to it.
const RECOVERY_ABANDON_MS = 15 * 60 * 1000;
const SWEEP_BATCH = 20;
const CONTROL_SCAN = 20;
// A failed removal backs off exponentially to a minute and counts as degraded
// after five attempts.
const CONTROL_RETRY_MAX_MS = 60_000;
export const CONTROL_DEGRADED_ATTEMPTS = 5;
const SERIALIZABLE_ATTEMPTS = 5;
// The caller and staff stay admitted while an AI failure awaits recovery.
const LIVE_STATES = ["ACTIVE", "RECOVERY_REQUIRED"] as const;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const workerParticipantIdentity = (callId: string) => `msva-agent-${hash(callId).slice(0, 32)}`;
const stable = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;

export class VoiceError extends Error { constructor(readonly status: number, readonly code: string, message = "Voice service request denied") { super(message); } }
export type VerifiedBrowserClaims = Readonly<{ subject: string; room: string; roomJoin: boolean; publish: boolean; subscribe: boolean }>;
export type VoiceDb = PrismaClient | Prisma.TransactionClient;
export type RevocationReason = "LOGOUT" | "USER_DISABLED" | "ROLE_CHANGED" | "SESSION_EXPIRED" | "OWNERSHIP_CHANGED" | "CALL_ENDED" | "CONTROL_LOST";
type AdmissionRole = "CALLER" | "OPERATOR_LISTENER" | "OPERATOR_SPEAKER";
type Denied = { denied: VoiceError };
const deny = (status: number, code: string): Denied => ({ denied: new VoiceError(status, code) });
const isDenied = (value: unknown): value is Denied => typeof value === "object" && value !== null && "denied" in value;

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
function canonicalLanguage(value: string): "hi" | "en" | "hinglish" {
  const normalized = value.toLowerCase().replace("_", "-");
  if (normalized === "hinglish" || normalized === "hi-en" || normalized === "en-hi") return "hinglish";
  return normalized.startsWith("en") ? "en" : "hi";
}
function prompt(language: string): string {
  const spoken = { hi: "Hindi", en: "English", hinglish: "Hindi-English Hinglish" }[canonicalLanguage(language)];
  return `You are Madhusudan support. Speak ${spoken} clearly. Do not claim access to prior history, deliveries, account records, or staff actions unless the current call context proves it. You may only say a business request was recorded after create_business_request returns a receipt; label it as pending staff follow-up. Never promise resolution, callback timing, refund, stock, or human takeover.`;
}
function serializationFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.meta?.code === "40001");
}
async function serializable<T>(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    // Random, growing waits keep conflicting retries from colliding again.
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * 2 ** attempt));
    try { return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new VoiceError(409, "CONFLICT");
      if (!serializationFailure(error)) throw error;
    }
  }
  throw new VoiceError(503, "VOICE_RETRY_EXHAUSTED");
}
/** Runs `work`; a returned denial commits the transaction's writes and is thrown afterwards. */
async function committed<T>(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T | Denied>): Promise<T> {
  const outcome = await serializable(db, work);
  if (isDenied(outcome)) throw outcome.denied;
  return outcome;
}
async function lockedSession(tx: VoiceDb, callId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "VoiceSession" WHERE "callId" = ${callId} FOR UPDATE`);
  const session = await tx.voiceSession.findFirst({ where: { callId }, include: { participants: true, lease: true } });
  if (!session) throw new VoiceError(404, "CALL_NOT_FOUND");
  return session;
}
type LockedSession = Awaited<ReturnType<typeof lockedSession>>;
/**
 * Verifies a call-scoped lease token before taking the session lock, so an
 * unauthenticated caller can neither queue on the lock nor learn whether a
 * call exists (unknown calls and bad tokens both answer 401).
 */
async function authenticatedSession(tx: VoiceDb, callId: string, token: string): Promise<LockedSession & { lease: NonNullable<LockedSession["lease"]> }> {
  const candidate = await tx.voiceSession.findFirst({ where: { callId }, select: { id: true, lease: { select: { agentEpoch: true, tokenHash: true } } } });
  if (!candidate?.lease || !tokenEquals(`Bearer ${token}`, leaseToken(candidate.id, candidate.lease.agentEpoch)) || hash(token) !== candidate.lease.tokenHash) throw new VoiceError(401, "LEASE_INVALID");
  const session = await lockedSession(tx, callId);
  if (session.id !== candidate.id || !session.lease || session.lease.tokenHash !== candidate.lease.tokenHash) throw new VoiceError(401, "LEASE_INVALID");
  return session as LockedSession & { lease: NonNullable<LockedSession["lease"]> };
}
function currentAuthority(session: LockedSession & { lease: NonNullable<LockedSession["lease"]> }, now: Date) {
  if (session.lease.expiresAt <= now) throw new VoiceError(409, "LEASE_EXPIRED");
  if (session.state !== "ACTIVE" || session.ownershipMode !== "AI") throw new VoiceError(409, "SESSION_UNAVAILABLE");
  return session.lease;
}
async function lockedAdmission(tx: VoiceDb, where: { participantIdentity: string } | { id: string }) {
  if ("id" in where) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "VoiceAdmission" WHERE "id" = ${where.id} FOR UPDATE`);
  else await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "VoiceAdmission" WHERE "participantIdentity" = ${where.participantIdentity} FOR UPDATE`);
  return tx.voiceAdmission.findUnique({ where, include: { voiceSession: true } });
}

/** Ends a call that never got a worker within its startup deadline. */
async function failStartedCall(tx: Prisma.TransactionClient, session: { id: string; callId: string }, now: Date): Promise<void> {
  await tx.voiceSession.update({ where: { id: session.id }, data: { state: "FAILED", endedAt: now } });
  const call = await tx.call.findUnique({ where: { id: session.callId }, select: { startedAt: true, endedAt: true, outcome: true } });
  if (call && !call.endedAt) {
    await tx.call.update({ where: { id: session.callId }, data: { status: "FAILED", endedAt: now, durationMs: now.getTime() - call.startedAt.getTime(), ...(call.outcome === "IN_PROGRESS" ? { outcome: "ABANDONED" as const } : {}) } });
  }
  await revokeAdmissions(tx, { callId: session.callId, reason: "CALL_ENDED" }, now);
}

/**
 * Ends startups that never got a worker and hands calls whose AI worker
 * stopped renewing to staff recovery. A human-owned call is not the AI's to
 * give up.
 */
async function reclaimExpiredAuthority(tx: Prisma.TransactionClient, now: Date): Promise<void> {
  for (const stale of await tx.voiceSession.findMany({ where: { state: "STARTING", expiresAt: { lte: now } }, select: { id: true, callId: true }, take: SWEEP_BATCH })) await failStartedCall(tx, stale, now);
  await tx.voiceSession.updateMany({ where: { state: "ACTIVE", ownershipMode: "AI", lease: { expiresAt: { lte: now } } }, data: { state: "RECOVERY_REQUIRED" } });
}

export async function createVoiceSession(input: { requestId: string; callId: string; ownerUserId?: string; ownerSessionId?: string; language?: string; callerParticipantId: string }, db: PrismaClient = prisma) {
  // Hash the request with its defaults applied, so an explicit default and an
  // omitted field are the same request.
  const request = { requestId: input.requestId, callId: input.callId, ownerUserId: input.ownerUserId ?? null, ownerSessionId: input.ownerSessionId ?? null, language: input.language ?? "hi", callerParticipantId: input.callerParticipantId };
  const requestHash = hash(stable(request)); const roomName = `msva-${hash(`${input.callId}:${input.requestId}`).slice(0, 24)}`; const dispatchIntentId = randomUUID();
  return serializable(db, async (tx) => {
    const replay = await tx.voiceSession.findUnique({ where: { createRequestId: input.requestId } });
    if (replay) { if (replay.createRequestHash !== requestHash) throw new VoiceError(409, "CREATE_REQUEST_CONFLICT"); return replay; }
    const call = await tx.call.findUnique({ where: { id: input.callId }, select: { id: true } }); if (!call) throw new VoiceError(404, "CALL_NOT_FOUND");
    if (await tx.voiceSession.findFirst({ where: { callId: input.callId }, select: { id: true } })) throw new VoiceError(409, "CALL_SESSION_EXISTS");
    const now = new Date();
    // Stale startups and crashed workers must not hold AI capacity forever.
    await reclaimExpiredAuthority(tx, now);
    const count = await tx.voiceSession.count({ where: { state: { in: ["STARTING", "ACTIVE"] } } }); if (count >= MAX_ACTIVE_SESSIONS) throw new VoiceError(409, "ACTIVE_CAPACITY");
    return tx.voiceSession.create({ data: { callId: input.callId, roomName, ownerUserId: request.ownerUserId, ownerSessionId: request.ownerSessionId, createRequestId: input.requestId, createRequestHash: requestHash, dispatchIntentId, state: "STARTING", expiresAt: new Date(now.getTime() + STARTING_MS), language: request.language, prompt: prompt(request.language), participants: { create: [{ identity: input.callerParticipantId, role: "CALLER" }, { identity: workerParticipantIdentity(input.callId), role: "AGENT" }] } } });
  });
}

export async function recordVoiceDispatch(sessionId: string, providerDispatchId: string, db: PrismaClient = prisma) {
  return db.voiceSession.update({ where: { id: sessionId }, data: { providerDispatchId } });
}

export async function claimVoiceLease(input: { callId: string; roomName: string; dispatchId: string; participantId: string }, authorization: string | undefined, db: PrismaClient = prisma): Promise<VoiceLease> {
  const { workerToken } = configured(); if (!tokenEquals(authorization, workerToken)) throw new VoiceError(401, "WORKER_UNAUTHORIZED");
  return committed(db, async (tx) => {
    const session = await lockedSession(tx, input.callId);
    const now = new Date();
    const agent = session.participants.find((p) => p.identity === input.participantId && p.role === "AGENT");
    if (!agent || session.roomName !== input.roomName) throw new VoiceError(403, "DISPATCH_MISMATCH");
    if (!session.providerDispatchId) throw new VoiceError(503, "DISPATCH_PENDING");
    if (session.providerDispatchId !== input.dispatchId) throw new VoiceError(403, "DISPATCH_MISMATCH");
    if (session.state === "RECOVERY_REQUIRED") return deny(409, "RECOVERY_REQUIRED");
    if (session.state === "STARTING" && session.expiresAt && session.expiresAt <= now) {
      await failStartedCall(tx, session, now);
      return deny(409, "SESSION_UNAVAILABLE");
    }
    if ((session.state !== "STARTING" && session.state !== "ACTIVE") || session.ownershipMode !== "AI") throw new VoiceError(409, "SESSION_UNAVAILABLE");
    if (session.lease) {
      // No automatic new epoch after a crash: an expired lease hands the call to staff.
      if (session.lease.expiresAt <= now) { await tx.voiceSession.update({ where: { id: session.id }, data: { state: "RECOVERY_REQUIRED" } }); return deny(409, "RECOVERY_REQUIRED"); }
      return leaseResponse(session.id, session.callId, session.lease.agentEpoch, session.lease.expiresAt);
    }
    const epoch = session.currentEpoch + 1; const expiresAt = new Date(now.getTime() + LEASE_MS); const token = leaseToken(session.id, epoch);
    await tx.voiceSession.update({ where: { id: session.id }, data: { currentEpoch: epoch, state: "ACTIVE", lease: { create: { agentEpoch: epoch, tokenHash: hash(token), expiresAt } } } });
    return leaseResponse(session.id, session.callId, epoch, expiresAt);
  });
}

export async function voiceContext(callId: string, token: string, db: PrismaClient = prisma) {
  return serializable(db, async (tx) => {
    const session = await authenticatedSession(tx, callId, token);
    const lease = currentAuthority(session, new Date());
    const caller = session.participants.find((participant) => participant.role === "CALLER");
    const agent = session.participants.find((participant) => participant.role === "AGENT");
    if (!caller || !agent) throw new VoiceError(503, "SESSION_INCOMPLETE");
    return { callId, roomName: session.roomName, agentEpoch: lease.agentEpoch, callerParticipantId: caller.identity, agentParticipantId: agent.identity, language: session.language, permittedTools: ["create_business_request"] as const, prompt: session.prompt };
  });
}

export async function renewVoiceLease(callId: string, epoch: number, token: string, db: PrismaClient = prisma): Promise<VoiceLease> {
  return serializable(db, async (tx) => {
    const session = await authenticatedSession(tx, callId, token);
    const now = new Date();
    const lease = currentAuthority(session, now);
    if (lease.agentEpoch !== epoch) throw new VoiceError(409, "LEASE_STALE");
    const expiresAt = new Date(now.getTime() + LEASE_MS);
    await tx.voiceLease.update({ where: { id: lease.id }, data: { expiresAt, renewedAt: now } });
    return leaseResponse(session.id, callId, epoch, expiresAt);
  });
}

export async function recordVoiceEvent(event: WorkerEvent, token: string, db: PrismaClient = prisma) {
  return serializable(db, async (tx) => {
    const session = await authenticatedSession(tx, event.callId, token);
    const now = new Date();
    const lease = session.lease;
    const cutoff = session.endedAt && session.endedAt < lease.expiresAt ? session.endedAt : lease.expiresAt;
    if (now.getTime() > cutoff.getTime() + REPLAY_MS) throw new VoiceError(409, "LEASE_EXPIRED");
    const hasAuthority = lease.expiresAt > now && session.state === "ACTIVE" && session.ownershipMode === "AI";
    if (lease.agentEpoch !== event.agentEpoch) throw new VoiceError(403, "EPOCH_MISMATCH");
    const occurredAt = new Date(event.occurredAt);
    const isFlush = event.type === "transcript.flushed";
    const latestAllowed = isFlush ? cutoff.getTime() + REPLAY_MS : cutoff.getTime() + CLOCK_SKEW_MS;
    if (!Number.isFinite(occurredAt.getTime())
      || occurredAt.getTime() < lease.createdAt.getTime() - CLOCK_SKEW_MS
      || occurredAt.getTime() > now.getTime() + CLOCK_SKEW_MS
      || occurredAt.getTime() > latestAllowed) throw new VoiceError(409, "EVENT_TIME_INVALID");
    const canonicalBody = stable(event); const bodyHash = hash(canonicalBody);
    const byId = await tx.voiceEvent.findUnique({ where: { sessionId_eventId: { sessionId: session.id, eventId: event.eventId } } });
    if (byId) { if (byId.bodyHash !== bodyHash) throw new VoiceError(409, "EVENT_CONFLICT"); return { eventId: event.eventId, status: "duplicate" as const }; }
    const bySequence = await tx.voiceEvent.findUnique({ where: { sessionId_agentEpoch_sourceSequence: { sessionId: session.id, agentEpoch: event.agentEpoch, sourceSequence: event.sourceSequence } } }); if (bySequence) throw new VoiceError(409, "SEQUENCE_CONFLICT");
    const watermark = await tx.voiceEvent.aggregate({ where: { sessionId: session.id, agentEpoch: event.agentEpoch }, _max: { sourceSequence: true } });
    if (event.sourceSequence !== (watermark._max.sourceSequence ?? 0) + 1) throw new VoiceError(409, "SEQUENCE_OUT_OF_ORDER");
    const bodyBytes = Buffer.byteLength(canonicalBody);
    // Read from the events themselves: a counter on the session row would be
    // written by every event and make concurrent renewals and tools retry.
    const stored = await tx.voiceEvent.aggregate({ where: { sessionId: session.id }, _count: { _all: true }, _sum: { bodyBytes: true } });
    if (stored._count._all >= MAX_SESSION_EVENTS || (stored._sum.bodyBytes ?? 0) + bodyBytes > MAX_SESSION_EVENT_BYTES) {
      // One checkpoint may still follow the last accepted event, so a stream
      // that reaches the limit can still be complete.
      const previous = isFlush ? await tx.voiceEvent.findUnique({ where: { sessionId_agentEpoch_sourceSequence: { sessionId: session.id, agentEpoch: event.agentEpoch, sourceSequence: event.sourceSequence - 1 } }, select: { type: true } }) : null;
      if (!previous || previous.type === "transcript.flushed") throw new VoiceError(409, "EVENT_CAPACITY");
    }
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
        await markPostCallAssessmentDirty(tx, event.callId, now);
      }
    }
    if (event.type === "agent.ready" && event.payload.participantId !== agent?.identity) throw new VoiceError(403, "PARTICIPANT_MISMATCH");
    // Worker pause/stop controls are not issued yet, so every acknowledgement
    // names an unknown control. Browser media controls (GRANT/REMOVE) belong
    // to the gateway executor and are never changed by the worker.
    if (event.type === "control.ack") throw new VoiceError(409, "CONTROL_ACK_INVALID");
    await tx.voiceEvent.create({ data: { sessionId: session.id, eventId: event.eventId, agentEpoch: event.agentEpoch, sourceSequence: event.sourceSequence, canonicalBody, bodyHash, bodyBytes, type: event.type, occurredAt } });
    if (event.type === "transcript.flushed") {
      if (event.payload.lastSourceSequence !== event.sourceSequence - 1 || event.payload.lastSourceSequence !== (watermark._max.sourceSequence ?? 0)) throw new VoiceError(409, "FLUSH_WATERMARK_INVALID");
      await tx.voiceSession.update({ where: { id: session.id }, data: { finalWatermark: event.payload.lastSourceSequence } });
    }
    // Any reported worker failure while it holds authority fences that epoch
    // and hands the live call to staff recovery. A late or historical failure
    // is evidence only and cannot disturb a newer owner.
    if (event.type === "agent.failed" && hasAuthority) {
      await tx.voiceSession.update({ where: { id: session.id }, data: { state: "RECOVERY_REQUIRED" } });
      await tx.voiceLease.update({ where: { id: lease.id }, data: { expiresAt: now } });
    }
    // Evidence that arrives after the call ended keeps its record truthful.
    if (session.state === "ENDED" || session.state === "FAILED") await recordLateEvidence(tx, session, isFlush, now);
    return { eventId: event.eventId, status: "committed" as const };
  });
}

/** Outcome from evidence only: a ticket is a ticket, silence is abandonment, and nothing else claims resolution. */
async function evidencedOutcome(tx: Prisma.TransactionClient, callId: string, sessionId: string, recorded: CallOutcome): Promise<CallOutcome> {
  if (recorded !== "IN_PROGRESS") return recorded;
  if (await tx.ticket.count({ where: { callId } }) > 0) return "TICKET_CREATED";
  if (await tx.transcriptSegment.count({ where: { sessionId, speaker: "CALLER", isCurrent: true } }) === 0) return "ABANDONED";
  return "IN_PROGRESS";
}

/** Whether the evidence stream ends in a checkpoint covering everything before it. */
async function checkpointed(tx: Prisma.TransactionClient, session: { id: string; currentEpoch: number; finalWatermark: number }): Promise<boolean> {
  const latest = await tx.voiceEvent.findFirst({ where: { sessionId: session.id, agentEpoch: session.currentEpoch }, orderBy: { sourceSequence: "desc" }, select: { type: true, sourceSequence: true } });
  return latest?.type === "transcript.flushed" && session.finalWatermark === latest.sourceSequence - 1;
}

/**
 * Ends a call whatever its evidence: the AI loses its lease, the call gets its
 * end time and an evidenced outcome, and all media admission is revoked.
 * Whether the transcript is complete is recorded alongside; evidence that
 * arrives later updates it.
 */
async function endSession(tx: Prisma.TransactionClient, session: LockedSession, now: Date, status: "COMPLETED" | "FAILED"): Promise<void> {
  if (session.lease && session.lease.expiresAt > now) await tx.voiceLease.update({ where: { id: session.lease.id }, data: { expiresAt: now } });
  const transcriptComplete = await checkpointed(tx, session);
  await tx.voiceSession.update({ where: { id: session.id }, data: { state: status === "COMPLETED" ? "ENDED" : "FAILED", endedAt: now, transcriptComplete, authorizationVersion: { increment: 1 } } });
  const call = await tx.call.findUniqueOrThrow({ where: { id: session.callId }, select: { startedAt: true, endedAt: true, outcome: true } });
  if (!call.endedAt) {
    const outcome = await evidencedOutcome(tx, session.callId, session.id, call.outcome);
    await tx.call.update({ where: { id: session.callId }, data: { status, endedAt: now, durationMs: now.getTime() - call.startedAt.getTime(), outcome } });
  }
  await revokeAdmissions(tx, { callId: session.callId, reason: "CALL_ENDED" }, now);
  await markPostCallAssessmentDirty(tx, session.callId, now);
}

/**
 * Evidence for a call that has ended: completeness follows the latest event,
 * and once the stream is complete again an outcome that depended on missing
 * evidence (abandoned or unconfirmed) is derived afresh.
 */
async function recordLateEvidence(tx: Prisma.TransactionClient, session: LockedSession, complete: boolean, now: Date): Promise<void> {
  if (session.transcriptComplete !== complete) await tx.voiceSession.update({ where: { id: session.id }, data: { transcriptComplete: complete } });
  if (!complete) return;
  const call = await tx.call.findUniqueOrThrow({ where: { id: session.callId }, select: { outcome: true } });
  if (call.outcome !== "ABANDONED" && call.outcome !== "IN_PROGRESS") return;
  const outcome = await evidencedOutcome(tx, session.callId, session.id, "IN_PROGRESS");
  if (outcome === call.outcome) return;
  await tx.call.update({ where: { id: session.callId }, data: { outcome } });
  await markPostCallAssessmentDirty(tx, session.callId, now);
}

/**
 * The call's lifecycle end, when the caller leaves or the room closes. It does
 * not need a complete transcript: completeness is recorded, not required.
 */
export async function finalizeVoiceSession(callId: string, db: PrismaClient = prisma): Promise<void> {
  await serializable(db, async (tx) => {
    const session = await lockedSession(tx, callId);
    if (session.state === "ENDED" || session.state === "FAILED") return;
    await endSession(tx, session, new Date(), "COMPLETED");
  });
}

/**
 * Ends a call for a signed-in user allowed to: its caller, an operator
 * assigned to it, or an admin or supervisor. This is how a call waiting in
 * staff recovery is closed. Ending an ended call changes nothing.
 */
export async function endVoiceCall(input: { callId: string; userId: string; sessionId: string }, db: PrismaClient = prisma): Promise<void> {
  await serializable(db, async (tx) => {
    const session = await lockedSession(tx, input.callId);
    const now = new Date();
    const browser = await tx.session.findFirst({ where: { id: input.sessionId, userId: input.userId, expiresAt: { gt: now }, user: { active: true } }, include: { user: true } });
    const allowed = Boolean(browser) && (browser!.user.role === "ADMIN" || browser!.user.role === "SUPERVISOR"
      || (session.ownerUserId === input.userId && session.ownerSessionId === input.sessionId)
      || await tx.handoff.count({ where: { callId: input.callId, assignedUserId: input.userId, state: { in: ["ASSIGNED", "JOINING", "HUMAN_ACTIVE"] } } }) > 0);
    if (!allowed) throw new VoiceError(403, "END_DENIED");
    if (session.state === "ENDED" || session.state === "FAILED") return;
    await endSession(tx, session, now, "COMPLETED");
  });
}

/** A call in recovery that has waited long enough with nobody still admitted. */
const abandonedWhere = (now: Date): Prisma.VoiceSessionWhereInput => ({
  state: "RECOVERY_REQUIRED",
  lease: { expiresAt: { lte: new Date(now.getTime() - RECOVERY_ABANDON_MS) } },
  admissions: { none: { absoluteExpiresAt: { gt: now }, OR: [{ state: { in: ["CONNECTING", "ACTIVE"] } }, { state: "ISSUED", firstJoinExpiresAt: { gt: now } }] } }
});

/**
 * Upkeep for calls nobody ends explicitly, bounded per run: expired startups
 * fail, calls whose AI worker stopped renewing go to staff recovery, and a
 * recovery call that was abandoned is closed as failed. Returns how many calls
 * it closed.
 */
export async function sweepVoiceSessions(db: PrismaClient = prisma): Promise<number> {
  await serializable(db, async (tx) => reclaimExpiredAuthority(tx, new Date()));
  const candidates = await db.voiceSession.findMany({ where: abandonedWhere(new Date()), orderBy: { startedAt: "asc" }, take: SWEEP_BATCH, select: { callId: true } });
  let closed = 0;
  for (const { callId } of candidates) {
    // Rechecked under the lock: someone may have ended or joined the call since.
    const ended = await serializable(db, async (tx) => {
      const session = await lockedSession(tx, callId);
      const now = new Date();
      if (await tx.voiceSession.count({ where: { id: session.id, ...abandonedWhere(now) } }) === 0) return false;
      await endSession(tx, session, now, "FAILED");
      return true;
    });
    if (ended) closed += 1;
  }
  return closed;
}

const TOOL_ERROR_STATUS: Record<string, number> = { INVALID_REQUEST: 400, CALL_NOT_FOUND: 404, IDENTITY_REQUIRED: 403, PARENT_NOT_ACCESSIBLE: 403, IDEMPOTENCY_CONFLICT: 409 };
type StoredToolResult = CreateRequestResult | { error: string };
function storedResult(result: Prisma.JsonValue | null): StoredToolResult | null {
  return result && typeof result === "object" && !Array.isArray(result) ? result as unknown as StoredToolResult : null;
}
function replayTool(status: string, result: Prisma.JsonValue | null): CreateRequestResult | null {
  const stored = storedResult(result);
  if (status === "FAILED" && stored && "error" in stored) throw new VoiceError(TOOL_ERROR_STATUS[stored.error] ?? 409, stored.error);
  return status === "COMMITTED" && stored && !("error" in stored) ? stored : null;
}

export async function invokeVoiceTool(input: { callId: string; invocationId: string; agentEpoch: number; name: "create_business_request"; arguments: unknown }, token: string, db: PrismaClient = prisma): Promise<CreateRequestResult> {
  type Prepared = { kind: "replay"; result: CreateRequestResult } | { kind: "run"; canonicalPayload: string };
  const prepared = await serializable(db, async (tx): Promise<Prepared> => {
    const session = await authenticatedSession(tx, input.callId, token); const lease = currentAuthority(session, new Date());
    if (lease.agentEpoch !== input.agentEpoch) throw new VoiceError(409, "LEASE_STALE");
    const canonicalPayload = stable(input.arguments); const existing = await tx.toolInvocation.findUnique({ where: { sessionId_invocationId: { sessionId: session.id, invocationId: input.invocationId } } });
    if (existing) { if (existing.canonicalPayload !== canonicalPayload) throw new VoiceError(409, "INVOCATION_CONFLICT"); const replay = replayTool(existing.status, existing.result); return replay ? { kind: "replay", result: replay } : { kind: "run", canonicalPayload }; }
    await tx.toolInvocation.create({ data: { sessionId: session.id, invocationId: input.invocationId, agentEpoch: input.agentEpoch, name: input.name, canonicalPayload, payloadHash: hash(canonicalPayload), status: "PENDING" } });
    return { kind: "run", canonicalPayload };
  });
  if (prepared.kind === "replay") return prepared.result;
  if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) throw new VoiceError(400, "INVALID_TOOL_ARGUMENTS");
  // A bounded, stable request identity per invocation, whatever its length.
  const command = { ...(input.arguments as Record<string, unknown>), callId: input.callId, requestId: `voice:${hash(`${input.callId}:${input.invocationId}`).slice(0, 48)}` };
  const parsed = CreateRequestInputSchema.safeParse(command); if (!parsed.success) throw new VoiceError(400, "INVALID_TOOL_ARGUMENTS");
  type Outcome = { kind: "done"; result: CreateRequestResult } | { kind: "rejected"; code: string; invocationId: string };
  const outcome = await serializable(db, async (tx): Promise<Outcome> => {
    const session = await authenticatedSession(tx, input.callId, token); const lease = currentAuthority(session, new Date());
    if (lease.agentEpoch !== input.agentEpoch) throw new VoiceError(409, "LEASE_STALE");
    const existing = await tx.toolInvocation.findUniqueOrThrow({ where: { sessionId_invocationId: { sessionId: session.id, invocationId: input.invocationId } } });
    if (existing.canonicalPayload !== prepared.canonicalPayload) throw new VoiceError(409, "INVOCATION_CONFLICT");
    const replay = replayTool(existing.status, existing.result); if (replay) return { kind: "done", result: replay };
    try {
      const result = await createBusinessRequest(tx, parsed.data);
      await tx.toolInvocation.update({ where: { id: existing.id }, data: { status: "COMMITTED", result: result as unknown as Prisma.InputJsonValue } });
      return { kind: "done", result };
    } catch (error) {
      // A permanent rejection is recorded so every retry gets the same answer.
      if (error instanceof DemoRequestError && error.code in TOOL_ERROR_STATUS) return { kind: "rejected", code: error.code, invocationId: existing.id };
      throw error;
    }
  });
  if (outcome.kind === "done") return outcome.result;
  await db.toolInvocation.updateMany({ where: { id: outcome.invocationId, status: "PENDING" }, data: { status: "FAILED", result: { error: outcome.code } } });
  throw new VoiceError(TOOL_ERROR_STATUS[outcome.code]!, outcome.code);
}

export async function voiceToolReceipt(callId: string, invocationId: string, token: string, db: PrismaClient = prisma): Promise<CreateRequestResult> {
  return serializable(db, async (tx) => {
    const session = await authenticatedSession(tx, callId, token);
    if (Date.now() > session.lease.expiresAt.getTime() + REPLAY_MS) throw new VoiceError(409, "LEASE_EXPIRED");
    const invocation = await tx.toolInvocation.findUnique({ where: { sessionId_invocationId: { sessionId: session.id, invocationId } } });
    const receipt = invocation ? replayTool(invocation.status, invocation.result) : null;
    if (!receipt) throw new VoiceError(404, "TOOL_RECEIPT_NOT_FOUND");
    return receipt;
  });
}

type Verdict = { ok: true } | { ok: false; reason: RevocationReason };
/**
 * Whether an admission is still authorized right now: live call, unchanged
 * assignment version, unexpired admission, the same active browser session
 * and a role the user still holds. Connect and every renewal use this check.
 */
async function admissionVerdict(tx: Prisma.TransactionClient, admission: NonNullable<Awaited<ReturnType<typeof lockedAdmission>>>, now: Date): Promise<Verdict> {
  const session = admission.voiceSession;
  if (!(LIVE_STATES as readonly string[]).includes(session.state)) return { ok: false, reason: "CALL_ENDED" };
  if (admission.authorizationVersion !== session.authorizationVersion) return { ok: false, reason: "OWNERSHIP_CHANGED" };
  if (admission.absoluteExpiresAt <= now) return { ok: false, reason: "SESSION_EXPIRED" };
  const browser = await tx.session.findFirst({ where: { id: admission.sessionId, userId: admission.userId }, include: { user: true } });
  if (!browser) return { ok: false, reason: "LOGOUT" };
  if (browser.expiresAt <= now) return { ok: false, reason: "SESSION_EXPIRED" };
  if (!browser.user.active) return { ok: false, reason: "USER_DISABLED" };
  return (await roleAllowed(tx, admission.role, { userId: admission.userId, sessionId: admission.sessionId, userRole: browser.user.role }, session)) ? { ok: true } : { ok: false, reason: "ROLE_CHANGED" };
}
async function roleAllowed(tx: Prisma.TransactionClient, role: AdmissionRole, who: { userId: string; sessionId: string; userRole: string }, session: { callId: string; ownerUserId: string | null; ownerSessionId: string | null; ownershipMode: string }): Promise<boolean> {
  if (role === "CALLER") return session.ownerUserId === who.userId && session.ownerSessionId === who.sessionId;
  if (who.userRole === "VIEWER") return false;
  const assignment = await tx.handoff.findFirst({ where: { callId: session.callId, assignedUserId: who.userId, state: role === "OPERATOR_SPEAKER" ? "HUMAN_ACTIVE" : { in: ["ASSIGNED", "JOINING", "HUMAN_ACTIVE"] } } });
  return Boolean(assignment) && (role !== "OPERATOR_SPEAKER" || session.ownershipMode === "HUMAN");
}

export async function prepareBrowserAdmission(input: { callId: string; userId: string; sessionId: string; role: AdmissionRole; expectedAuthorizationVersion: number }, db: PrismaClient = prisma) {
  return serializable(db, async (tx) => {
    const session = await lockedSession(tx, input.callId);
    const now = new Date();
    const browser = await tx.session.findFirst({ where: { id: input.sessionId, userId: input.userId, expiresAt: { gt: now }, user: { active: true } }, include: { user: true } });
    if (!browser || session.authorizationVersion !== input.expectedAuthorizationVersion || !(LIVE_STATES as readonly string[]).includes(session.state)) throw new VoiceError(403, "ADMISSION_DENIED");
    if (!(await roleAllowed(tx, input.role, { userId: input.userId, sessionId: input.sessionId, userRole: browser.user.role }, session))) throw new VoiceError(403, "ADMISSION_DENIED");
    const caller = session.participants.find((participant) => participant.role === "CALLER");
    if (input.role === "CALLER" && !caller) throw new VoiceError(503, "SESSION_INCOMPLETE");
    const absolute = new Date(Math.min(now.getTime() + 2 * 60 * 60 * 1000, browser.expiresAt.getTime()));
    const firstJoin = new Date(now.getTime() + 60_000);
    const existing = await tx.voiceAdmission.findFirst({ where: { voiceSessionId: session.id, sessionId: input.sessionId, userId: input.userId, role: input.role, state: { in: ["ISSUED", "CONNECTING", "ACTIVE"] } } });
    if (existing) {
      const unusedAndLapsed = existing.state === "ISSUED" && (existing.firstJoinExpiresAt <= now || existing.absoluteExpiresAt <= now);
      if (!unusedAndLapsed) return existing;
      // The caller identity is bound to transcripts, so a never-used caller
      // admission is re-armed; an operator gets a fresh opaque identity.
      if (input.role === "CALLER") return tx.voiceAdmission.update({ where: { id: existing.id }, data: { firstJoinExpiresAt: firstJoin, absoluteExpiresAt: absolute, authorizationVersion: session.authorizationVersion } });
      await tx.voiceAdmission.update({ where: { id: existing.id }, data: { state: "EXPIRED" } });
    }
    if (input.role === "CALLER") {
      const prior = await tx.voiceAdmission.findUnique({ where: { participantIdentity: caller!.identity } });
      if (prior) throw new VoiceError(409, (["ISSUED", "CONNECTING", "ACTIVE"] as string[]).includes(prior.state) ? "CALLER_ADMISSION_EXISTS" : "CALLER_ADMISSION_CLOSED");
    }
    return tx.voiceAdmission.create({ data: { callId: input.callId, voiceSessionId: session.id, sessionId: input.sessionId, userId: input.userId, participantIdentity: input.role === "CALLER" ? caller!.identity : `adm_${randomUUID()}`, role: input.role, authorizationVersion: session.authorizationVersion, firstJoinExpiresAt: firstJoin, absoluteExpiresAt: absolute } });
  });
}

/** Revokes matching live admissions: REVOKING, new version, pending grants cancelled, one REMOVE intent each. */
export async function revokeAdmissions(tx: Prisma.TransactionClient, input: { admissionId?: string; sessionId?: string; userId?: string; callId?: string; reason: RevocationReason }, now = new Date()): Promise<void> {
  if (!input.admissionId && !input.sessionId && !input.userId && !input.callId) throw new VoiceError(400, "REVOCATION_SCOPE_REQUIRED");
  const admissions = await tx.voiceAdmission.findMany({ where: { ...(input.admissionId ? { id: input.admissionId } : {}), ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.userId ? { userId: input.userId } : {}), ...(input.callId ? { callId: input.callId } : {}), state: { in: ["ISSUED", "CONNECTING", "ACTIVE"] } } });
  for (const admission of admissions) {
    const version = admission.authorizationVersion + 1;
    const revoked = await tx.voiceAdmission.updateMany({ where: { id: admission.id, authorizationVersion: admission.authorizationVersion, state: { in: ["ISSUED", "CONNECTING", "ACTIVE"] } }, data: { state: "REVOKING", authorizationVersion: version, revokedAt: now, revokeReason: input.reason, connectionLeaseExpiresAt: now, connectionOwner: null } });
    if (revoked.count !== 1) continue;
    await tx.mediaControlIntent.updateMany({ where: { admissionId: admission.id, kind: "GRANT", status: "PENDING" }, data: { status: "FAILED", errorCode: "REVOKED", leaseExpiresAt: null } });
    // An in-flight grant keeps its attempt lease: the REMOVE below cannot be
    // claimed until that attempt finishes or its lease runs out, so an older
    // grant can never land after the removal.
    await tx.mediaControlIntent.updateMany({ where: { admissionId: admission.id, kind: "GRANT", status: "RUNNING" }, data: { errorCode: "REVOKED" } });
    await tx.mediaControlIntent.create({ data: { admissionId: admission.id, authorizationVersion: version, kind: "REMOVE" } });
  }
}

export async function authorizeSignalConnection(input: { tokenClaims: VerifiedBrowserClaims; sessionTokenHash: string; origin: string; protocol: "v0" | "v1"; reconnect: boolean; participantSid: string | null }, db: PrismaClient = prisma) {
  // This is intentionally an internal, post-verifier primitive. No HTTP route accepts claims.
  return committed(db, async (tx) => {
    const admission = await lockedAdmission(tx, { participantIdentity: input.tokenClaims.subject });
    if (!admission) throw new VoiceError(403, "ADMISSION_DENIED");
    const now = new Date();
    const session = admission.voiceSession;
    const expectedOrigin = process.env.VOICE_BROWSER_ORIGIN;
    // The first join uses a join-only token; later connections may carry the
    // refreshed grants, but never more than the admission's role allows.
    const grantsAllowed = admission.state === "ISSUED"
      ? !input.tokenClaims.publish && !input.tokenClaims.subscribe
      : !input.tokenClaims.publish || admission.role !== "OPERATOR_LISTENER";
    if (!expectedOrigin || input.origin !== expectedOrigin || (input.protocol !== "v0" && input.protocol !== "v1")
      || !input.tokenClaims.roomJoin || !grantsAllowed || session.roomName !== input.tokenClaims.room
      || admission.state === "REVOKING" || admission.state === "REVOKED" || admission.state === "EXPIRED"
      || (admission.state === "ISSUED" && admission.firstJoinExpiresAt <= now)) throw new VoiceError(403, "ADMISSION_DENIED");
    const verdict = await admissionVerdict(tx, admission, now);
    if (!verdict.ok) { await revokeAdmissions(tx, { admissionId: admission.id, reason: verdict.reason }, now); return deny(403, "ADMISSION_DENIED"); }
    // A different browser session presenting this token is refused without
    // revoking the owner's admission.
    if (!(await tx.session.findFirst({ where: { id: admission.sessionId, tokenHash: input.sessionTokenHash }, select: { id: true } }))) throw new VoiceError(403, "ADMISSION_DENIED");
    if (admission.connectionLeaseExpiresAt && admission.connectionLeaseExpiresAt > now) throw new VoiceError(409, "CONNECTION_ACTIVE");
    if (!input.reconnect && input.participantSid) throw new VoiceError(403, "INITIAL_SID_FORBIDDEN");
    if (input.reconnect && (!input.participantSid || admission.participantSid !== input.participantSid)) throw new VoiceError(403, "RECONNECT_MISMATCH");
    const epoch = admission.connectionEpoch + 1;
    const until = new Date(now.getTime() + CONNECTION_MS);
    const owner = randomUUID();
    await tx.voiceAdmission.update({ where: { id: admission.id }, data: { connectionEpoch: epoch, connectionOwner: owner, connectionLeaseExpiresAt: until, lastAuthorizedAt: now, state: admission.state === "ISSUED" ? "CONNECTING" : admission.state } });
    return { admissionId: admission.id, callId: admission.callId, participantIdentity: admission.participantIdentity, authorizationVersion: admission.authorizationVersion, connectionEpoch: epoch, connectionOwner: owner, connectionLeaseExpiresAt: until };
  });
}

type ConnectionRef = { admissionId: string; connectionEpoch: number; connectionOwner: string };
async function ownedConnection(tx: Prisma.TransactionClient, input: ConnectionRef, now: Date) {
  const admission = await lockedAdmission(tx, { id: input.admissionId });
  if (!admission || admission.connectionEpoch !== input.connectionEpoch || admission.connectionOwner !== input.connectionOwner
    || !admission.connectionLeaseExpiresAt || admission.connectionLeaseExpiresAt <= now
    || (admission.state !== "CONNECTING" && admission.state !== "ACTIVE")) throw new VoiceError(409, "CONNECTION_STALE");
  return admission;
}

/** Extends a live connection only after re-checking its authorization; a failed check revokes it. */
export async function renewSignalConnection(input: ConnectionRef, db: PrismaClient = prisma) {
  return committed(db, async (tx) => {
    const now = new Date();
    const admission = await ownedConnection(tx, input, now);
    const verdict = await admissionVerdict(tx, admission, now);
    if (!verdict.ok) { await revokeAdmissions(tx, { admissionId: admission.id, reason: verdict.reason }, now); return deny(409, "CONNECTION_REVOKED"); }
    const connectionLeaseExpiresAt = new Date(now.getTime() + CONNECTION_MS);
    await tx.voiceAdmission.update({ where: { id: admission.id }, data: { connectionLeaseExpiresAt, lastAuthorizedAt: now, state: "ACTIVE" } });
    return { connectionLeaseExpiresAt };
  });
}

/** Records the SFU participant SID of the owned connection, for later reconnect checks. */
export async function confirmSignalParticipant(input: ConnectionRef & { participantSid: string }, db: PrismaClient = prisma): Promise<void> {
  await serializable(db, async (tx) => {
    await ownedConnection(tx, input, new Date());
    await tx.voiceAdmission.update({ where: { id: input.admissionId }, data: { participantSid: input.participantSid } });
  });
}

export async function releaseSignalConnection(input: ConnectionRef, db: PrismaClient = prisma): Promise<void> {
  await serializable(db, async (tx) => {
    const released = await tx.voiceAdmission.updateMany({ where: { id: input.admissionId, connectionEpoch: input.connectionEpoch, connectionOwner: input.connectionOwner, state: { in: ["CONNECTING", "ACTIVE"] } }, data: { connectionOwner: null, connectionLeaseExpiresAt: new Date() } });
    if (released.count !== 1) throw new VoiceError(409, "CONNECTION_STALE");
  });
}

/**
 * Claims one durable media instruction for a gateway worker. Intents run one
 * at a time per admission in creation order, and otherwise in the order they
 * became due, so a removal that keeps failing waits behind the others. An
 * attempt whose lease lapsed is reclaimed with a new token, which fences any
 * late response from the old one.
 */
export async function claimMediaControlIntent(db: PrismaClient = prisma) {
  return serializable(db, async (tx) => {
    const now = new Date();
    const candidates = await tx.mediaControlIntent.findMany({ where: { OR: [{ status: "PENDING", nextAttemptAt: { lte: now } }, { status: "RUNNING", leaseExpiresAt: { lte: now } }] }, orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }], take: CONTROL_SCAN, select: { id: true } });
    for (const { id } of candidates) {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MediaControlIntent" WHERE "id" = ${id} FOR UPDATE`);
      const current = await tx.mediaControlIntent.findUniqueOrThrow({ where: { id }, include: { admission: { include: { voiceSession: true } } } });
      const claimable = (current.status === "PENDING" && current.nextAttemptAt <= now) || (current.status === "RUNNING" && current.leaseExpiresAt !== null && current.leaseExpiresAt <= now);
      if (!claimable) continue;
      const blocked = await tx.mediaControlIntent.findFirst({ where: { admissionId: current.admissionId, id: { not: current.id }, OR: [{ status: "RUNNING", leaseExpiresAt: { gt: now } }, { status: { in: ["PENDING", "RUNNING"] }, createdAt: { lt: current.createdAt } }] }, select: { id: true } });
      if (blocked) continue;
      const validGrant = current.kind !== "GRANT" || (current.errorCode !== "REVOKED" && current.admission.state !== "REVOKING" && current.admission.state !== "REVOKED" && current.admission.authorizationVersion === current.authorizationVersion && current.admission.voiceSession.authorizationVersion === current.authorizationVersion);
      if (!validGrant) {
        await tx.mediaControlIntent.update({ where: { id: current.id }, data: { status: "FAILED", errorCode: "REVOKED", attemptToken: null, leaseExpiresAt: null } });
        continue;
      }
      const attemptToken = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + CONNECTION_MS);
      await tx.mediaControlIntent.update({ where: { id: current.id }, data: { status: "RUNNING", attemptToken, leaseExpiresAt, nextAttemptAt: leaseExpiresAt, attempts: { increment: 1 } } });
      return { id: current.id, admissionId: current.admissionId, authorizationVersion: current.authorizationVersion, kind: current.kind, attemptToken, leaseExpiresAt };
    }
    return null;
  });
}

/**
 * Completes the current attempt. A grant that lost its admission is recorded
 * as revoked even if the adapter applied it (the queued REMOVE undoes it). A
 * failed REMOVE returns to the queue after a growing wait: removal must
 * eventually succeed, and a confirmed REMOVE completes the revocation.
 */
export async function finishMediaControlIntent(input: { id: string; attemptToken: string; success: boolean; errorCode?: string }, db: PrismaClient = prisma): Promise<void> {
  const degraded = await serializable(db, async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MediaControlIntent" WHERE "id" = ${input.id} FOR UPDATE`);
    const intent = await tx.mediaControlIntent.findUnique({ where: { id: input.id }, include: { admission: true } });
    if (!intent || intent.status !== "RUNNING" || intent.attemptToken !== input.attemptToken) throw new VoiceError(409, "CONTROL_ATTEMPT_STALE");
    const done = { attemptToken: null, leaseExpiresAt: null };
    if (intent.kind === "GRANT") {
      const revoked = intent.errorCode === "REVOKED" || intent.admission.state === "REVOKING" || intent.admission.state === "REVOKED" || intent.admission.authorizationVersion !== intent.authorizationVersion;
      if (revoked) await tx.mediaControlIntent.update({ where: { id: intent.id }, data: { status: "FAILED", errorCode: "REVOKED", ...done } });
      else await tx.mediaControlIntent.update({ where: { id: intent.id }, data: { status: input.success ? "CONFIRMED" : "FAILED", errorCode: input.success ? null : input.errorCode ?? "ADAPTER_FAILED", ...done } });
      return false;
    }
    if (!input.success) {
      const retryAt = new Date(Date.now() + Math.min(CONTROL_RETRY_MAX_MS, 1_000 * 2 ** Math.max(0, intent.attempts - 1)));
      await tx.mediaControlIntent.update({ where: { id: intent.id }, data: { status: "PENDING", errorCode: input.errorCode ?? "ADAPTER_FAILED", nextAttemptAt: retryAt, ...done } });
      return intent.attempts === CONTROL_DEGRADED_ATTEMPTS;
    }
    await tx.mediaControlIntent.update({ where: { id: intent.id }, data: { status: "CONFIRMED", errorCode: null, ...done } });
    await tx.voiceAdmission.updateMany({ where: { id: intent.admissionId, state: "REVOKING", authorizationVersion: intent.authorizationVersion }, data: { state: "REVOKED" } });
    return false;
  });
  if (degraded) console.warn(`[voice] media removal ${input.id} has failed ${CONTROL_DEGRADED_ATTEMPTS} times; still retrying`);
}

/**
 * Removals still being retried after repeated failures: a revoked participant
 * may still have media, so staff should see these.
 */
export async function degradedMediaControls(db: PrismaClient = prisma) {
  return db.mediaControlIntent.findMany({ where: { kind: "REMOVE", status: { in: ["PENDING", "RUNNING"] }, attempts: { gte: CONTROL_DEGRADED_ATTEMPTS } }, orderBy: { createdAt: "asc" }, select: { id: true, admissionId: true, attempts: true, errorCode: true, nextAttemptAt: true } });
}
