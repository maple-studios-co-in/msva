import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, PrismaClient, createBusinessRequest, prisma } from "@msva/db";
import { CreateRequestInputSchema, type CreateRequestResult, type VoiceLease, type WorkerEvent } from "@msva/contracts";

const LEASE_MS = 30_000;
const REPLAY_MS = 24 * 60 * 60 * 1000;
const CONNECTION_MS = 10_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
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
function activeLease(session: Awaited<ReturnType<typeof lockedSession>>, token: string, now: Date, evidence = false) {
  if (!session.lease || !tokenEquals(`Bearer ${token}`, leaseToken(session.id, session.lease.agentEpoch)) || hash(token) !== session.lease.tokenHash) throw new VoiceError(401, "LEASE_INVALID");
  if (session.lease.expiresAt > now) return session.lease;
  if (evidence && now.getTime() - session.lease.expiresAt.getTime() <= REPLAY_MS) return session.lease;
  throw new VoiceError(409, "LEASE_EXPIRED");
}

export async function createVoiceSession(input: { callId: string; ownerUserId?: string; ownerSessionId?: string; language?: string; callerParticipantId: string; agentParticipantId: string }, db: PrismaClient = prisma) {
  const requestId = randomUUID(); const roomName = `msva-${hash(`${input.callId}:${requestId}`).slice(0, 24)}`; const dispatchIntentId = randomUUID();
  return serializable(db, async (tx) => {
    const call = await tx.call.findUnique({ where: { id: input.callId }, select: { id: true } }); if (!call) throw new VoiceError(404, "CALL_NOT_FOUND");
    const count = await tx.voiceSession.count({ where: { state: { in: ["STARTING", "ACTIVE"] } } }); if (count >= 2) throw new VoiceError(409, "ACTIVE_CAPACITY");
    return tx.voiceSession.create({ data: { callId: input.callId, roomName, ownerUserId: input.ownerUserId, ownerSessionId: input.ownerSessionId, createRequestId: requestId, createRequestHash: hash(requestId), dispatchIntentId, state: "STARTING", language: input.language ?? "hi", prompt: prompt(input.language ?? "hi"), participants: { create: [{ identity: input.callerParticipantId, role: "CALLER" }, { identity: input.agentParticipantId, role: "AGENT" }] } } });
  });
}

export async function recordVoiceDispatch(sessionId: string, providerDispatchId: string, db: PrismaClient = prisma) {
  return db.voiceSession.update({ where: { id: sessionId }, data: { providerDispatchId } });
}

export async function claimVoiceLease(input: { callId: string; roomName: string; dispatchId: string; participantId: string }, authorization: string | undefined, db: PrismaClient = prisma, now = new Date()): Promise<VoiceLease> {
  const { workerToken } = configured(); if (!tokenEquals(authorization, workerToken)) throw new VoiceError(401, "WORKER_UNAUTHORIZED");
  return serializable(db, async (tx) => {
    const session = await lockedSession(tx, input.callId);
    const agent = session.participants.find((p) => p.identity === input.participantId && p.role === "AGENT");
    if (!agent || session.roomName !== input.roomName) throw new VoiceError(403, "DISPATCH_MISMATCH");
    if (!session.providerDispatchId) throw new VoiceError(503, "DISPATCH_PENDING");
    if (session.providerDispatchId !== input.dispatchId) throw new VoiceError(403, "DISPATCH_MISMATCH");
    if (session.state === "ENDED" || session.state === "FAILED" || session.ownershipMode !== "AI") throw new VoiceError(409, "SESSION_UNAVAILABLE");
    if (session.lease) {
      if (session.lease.expiresAt <= now) { await tx.voiceSession.update({ where: { id: session.id }, data: { state: "RECOVERY_REQUIRED" } }); throw new VoiceError(409, "RECOVERY_REQUIRED"); }
      return leaseResponse(session.id, session.callId, session.lease.agentEpoch, session.lease.expiresAt);
    }
    const epoch = session.currentEpoch + 1; const expiresAt = new Date(now.getTime() + LEASE_MS); const token = leaseToken(session.id, epoch);
    await tx.voiceSession.update({ where: { id: session.id }, data: { currentEpoch: epoch, state: "ACTIVE", lease: { create: { agentEpoch: epoch, tokenHash: hash(token), expiresAt } } } });
    return leaseResponse(session.id, session.callId, epoch, expiresAt);
  });
}

export async function voiceContext(callId: string, token: string, db: PrismaClient = prisma, now = new Date()) {
  const session = await db.voiceSession.findFirst({ where: { callId }, include: { participants: true, lease: true } }); if (!session) throw new VoiceError(404, "CALL_NOT_FOUND");
  const lease = activeLease(session, token, now); if (session.state !== "ACTIVE" || session.ownershipMode !== "AI") throw new VoiceError(409, "SESSION_UNAVAILABLE");
  const caller = session.participants.find((p) => p.role === "CALLER"); const agent = session.participants.find((p) => p.role === "AGENT"); if (!caller || !agent) throw new VoiceError(503, "SESSION_INCOMPLETE");
  return { callId, roomName: session.roomName, agentEpoch: lease.agentEpoch, callerParticipantId: caller.identity, agentParticipantId: agent.identity, language: session.language, permittedTools: ["create_business_request"] as const, prompt: session.prompt };
}

export async function renewVoiceLease(callId: string, epoch: number, token: string, db: PrismaClient = prisma, now = new Date()): Promise<VoiceLease> {
  return serializable(db, async (tx) => { const session = await lockedSession(tx, callId); const lease = activeLease(session, token, now); if (lease.agentEpoch !== epoch || session.state !== "ACTIVE" || session.ownershipMode !== "AI") throw new VoiceError(409, "LEASE_STALE"); const expiresAt = new Date(now.getTime() + LEASE_MS); await tx.voiceLease.update({ where: { id: lease.id }, data: { expiresAt, renewedAt: now } }); return leaseResponse(session.id, callId, epoch, expiresAt); });
}

export async function recordVoiceEvent(event: WorkerEvent, token: string, db: PrismaClient = prisma, now = new Date()) {
  return serializable(db, async (tx) => {
    const session = await lockedSession(tx, event.callId); const evidence = event.type === "transcript.final"; const lease = activeLease(session, token, now, evidence);
    if (lease.agentEpoch !== event.agentEpoch) throw new VoiceError(403, "EPOCH_MISMATCH");
    const canonicalBody = stable(event); const bodyHash = hash(canonicalBody);
    const byId = await tx.voiceEvent.findUnique({ where: { sessionId_eventId: { sessionId: session.id, eventId: event.eventId } } });
    if (byId) { if (byId.bodyHash !== bodyHash) throw new VoiceError(409, "EVENT_CONFLICT"); return { eventId: event.eventId, status: "duplicate" as const }; }
    const bySequence = await tx.voiceEvent.findUnique({ where: { sessionId_agentEpoch_sourceSequence: { sessionId: session.id, agentEpoch: event.agentEpoch, sourceSequence: event.sourceSequence } } }); if (bySequence) throw new VoiceError(409, "SEQUENCE_CONFLICT");
    const watermark = await tx.voiceEvent.aggregate({ where: { sessionId: session.id, agentEpoch: event.agentEpoch }, _max: { sourceSequence: true } });
    if (event.sourceSequence !== (watermark._max.sourceSequence ?? 0) + 1) throw new VoiceError(409, "SEQUENCE_OUT_OF_ORDER");
    const caller = session.participants.find((p) => p.role === "CALLER"); const agent = session.participants.find((p) => p.role === "AGENT");
    if (event.type === "transcript.final") { const expected = event.payload.speaker === "CALLER" ? caller?.identity : event.payload.speaker === "AGENT" ? agent?.identity : undefined; if (!expected || expected !== event.payload.participantId) throw new VoiceError(403, "PARTICIPANT_MISMATCH"); const highest = await tx.transcriptSegment.aggregate({ where: { sessionId: session.id, segmentId: event.payload.segmentId }, _max: { revision: true } }); const current = !highest._max.revision || event.payload.revision >= highest._max.revision; if (current) await tx.transcriptSegment.updateMany({ where: { sessionId: session.id, segmentId: event.payload.segmentId, isCurrent: true }, data: { isCurrent: false } }); await tx.transcriptSegment.create({ data: { sessionId: session.id, segmentId: event.payload.segmentId, revision: event.payload.revision, speaker: event.payload.speaker, participantId: event.payload.participantId, sequence: event.payload.sequence, text: event.payload.text, startMs: event.payload.startMs ?? null, endMs: event.payload.endMs ?? null, language: event.payload.language, isCurrent: current } }); }
    if (event.type === "agent.ready" && event.payload.participantId !== agent?.identity) throw new VoiceError(403, "PARTICIPANT_MISMATCH");
    await tx.voiceEvent.create({ data: { sessionId: session.id, eventId: event.eventId, agentEpoch: event.agentEpoch, sourceSequence: event.sourceSequence, canonicalBody, bodyHash, type: event.type, occurredAt: new Date(event.occurredAt) } });
    if (event.type === "transcript.flushed") await tx.voiceSession.update({ where: { id: session.id }, data: { finalWatermark: Math.max(session.finalWatermark, event.payload.lastSourceSequence) } });
    return { eventId: event.eventId, status: "committed" as const };
  });
}

export async function invokeVoiceTool(input: { callId: string; invocationId: string; agentEpoch: number; name: "create_business_request"; arguments: unknown }, token: string, db: PrismaClient = prisma, now = new Date()): Promise<CreateRequestResult> {
  const prepared = await serializable(db, async (tx) => {
    const session = await lockedSession(tx, input.callId); const lease = activeLease(session, token, now);
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
  const result = await createBusinessRequest(db, parsed.data);
  return serializable(db, async (tx) => {
    const session = await lockedSession(tx, input.callId); const lease = activeLease(session, token, now);
    if (lease.agentEpoch !== input.agentEpoch || session.state !== "ACTIVE" || session.ownershipMode !== "AI") throw new VoiceError(409, "LEASE_STALE");
    const existing = await tx.toolInvocation.findUniqueOrThrow({ where: { sessionId_invocationId: { sessionId: session.id, invocationId: input.invocationId } } });
    if (existing.canonicalPayload !== prepared.canonicalPayload) throw new VoiceError(409, "INVOCATION_CONFLICT");
    if (existing.status === "COMMITTED" && existing.result) return existing.result as unknown as CreateRequestResult;
    await tx.toolInvocation.update({ where: { id: existing.id }, data: { status: "COMMITTED", result: result as unknown as Prisma.InputJsonValue } });
    return result;
  });
}

export async function voiceToolReceipt(callId: string, invocationId: string, token: string, db: PrismaClient = prisma, now = new Date()): Promise<CreateRequestResult> {
  const session = await db.voiceSession.findFirst({ where: { callId }, include: { participants: true, lease: true } }); if (!session) throw new VoiceError(404, "CALL_NOT_FOUND");
  activeLease(session, token, now, true);
  const invocation = await db.toolInvocation.findUnique({ where: { sessionId_invocationId: { sessionId: session.id, invocationId } } });
  if (!invocation || invocation.status !== "COMMITTED" || !invocation.result) throw new VoiceError(404, "TOOL_RECEIPT_NOT_FOUND");
  return invocation.result as unknown as CreateRequestResult;
}

export async function prepareBrowserAdmission(input: { callId: string; userId: string; sessionId: string; role: "CALLER" | "OPERATOR_LISTENER" | "OPERATOR_SPEAKER"; expectedAuthorizationVersion: number }, db: PrismaClient = prisma, now = new Date()) {
  return serializable(db, async (tx) => { const session = await lockedSession(tx, input.callId); const owner = await tx.session.findFirst({ where: { id: input.sessionId, userId: input.userId, expiresAt: { gt: now }, user: { active: true } } }); if (!owner || session.authorizationVersion !== input.expectedAuthorizationVersion || session.state === "ENDED") throw new VoiceError(403, "ADMISSION_DENIED"); const absolute = new Date(Math.min(now.getTime() + 2 * 60 * 60 * 1000, owner.expiresAt.getTime())); return tx.voiceAdmission.create({ data: { callId: input.callId, voiceSessionId: session.id, sessionId: input.sessionId, userId: input.userId, participantIdentity: `adm_${randomUUID()}`, role: input.role, authorizationVersion: session.authorizationVersion, firstJoinExpiresAt: new Date(now.getTime() + 60_000), absoluteExpiresAt: absolute } }); });
}

export async function revokeAdmissions(tx: Prisma.TransactionClient, input: { sessionId?: string; userId?: string; callId?: string; reason: "LOGOUT" | "USER_DISABLED" | "SESSION_EXPIRED" | "OWNERSHIP_CHANGED" | "CALL_ENDED" | "CONTROL_LOST" }, now = new Date()): Promise<void> {
  if (!input.sessionId && !input.userId && !input.callId) throw new VoiceError(400, "REVOCATION_SCOPE_REQUIRED");
  const admissions = await tx.voiceAdmission.findMany({ where: { ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.userId ? { userId: input.userId } : {}), ...(input.callId ? { callId: input.callId } : {}), state: { in: ["ISSUED", "CONNECTING", "ACTIVE"] } } });
  for (const admission of admissions) { const version = admission.authorizationVersion + 1; await tx.voiceAdmission.update({ where: { id: admission.id }, data: { state: "REVOKING", authorizationVersion: version, revokedAt: now, revokeReason: input.reason, connectionLeaseExpiresAt: now } }); await tx.mediaControlIntent.create({ data: { admissionId: admission.id, authorizationVersion: version, kind: "REMOVE" } }); }
}

export async function authorizeSignalConnection(input: { tokenClaims: VerifiedBrowserClaims; sessionTokenHash: string; origin: string; protocol: "v0" | "v1"; reconnect: boolean; participantSid: string | null; now: Date }, db: PrismaClient = prisma) {
  // This is intentionally an internal, post-verifier primitive. No HTTP route accepts claims.
  return serializable(db, async (tx) => { const admission = await tx.voiceAdmission.findUnique({ where: { participantIdentity: input.tokenClaims.subject }, include: { voiceSession: true } }); if (!admission || !input.tokenClaims.roomJoin || admission.voiceSession.roomName !== input.tokenClaims.room || admission.state === "REVOKING" || admission.state === "REVOKED" || admission.state === "EXPIRED" || admission.absoluteExpiresAt <= input.now || (admission.state === "ISSUED" && admission.firstJoinExpiresAt <= input.now)) throw new VoiceError(403, "ADMISSION_DENIED"); const browser = await tx.session.findFirst({ where: { id: admission.sessionId, userId: admission.userId, tokenHash: input.sessionTokenHash, expiresAt: { gt: input.now }, user: { active: true } } }); if (!browser || admission.authorizationVersion !== admission.voiceSession.authorizationVersion) throw new VoiceError(403, "ADMISSION_DENIED"); if (admission.connectionLeaseExpiresAt && admission.connectionLeaseExpiresAt > input.now) throw new VoiceError(409, "CONNECTION_ACTIVE"); if (input.reconnect && admission.participantSid !== input.participantSid) throw new VoiceError(403, "RECONNECT_MISMATCH"); const epoch = admission.connectionEpoch + 1; const until = new Date(input.now.getTime() + CONNECTION_MS); await tx.voiceAdmission.update({ where: { id: admission.id }, data: { connectionEpoch: epoch, connectionOwner: randomUUID(), connectionLeaseExpiresAt: until, participantSid: input.participantSid ?? admission.participantSid, lastAuthorizedAt: input.now, state: "CONNECTING" } }); return { admissionId: admission.id, callId: admission.callId, participantIdentity: admission.participantIdentity, authorizationVersion: admission.authorizationVersion, connectionEpoch: epoch, connectionLeaseExpiresAt: until }; });
}
