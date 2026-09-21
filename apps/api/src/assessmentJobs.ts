import { randomUUID } from "node:crypto";
import { Prisma, prisma } from "@msva/db";
import {
  buildAssessmentSnapshot,
  capabilityFor,
  readAssessmentSnapshot,
  readJevConfig,
  requestCallAssessment
} from "./callAssessment.js";

const SETTLE_MS = 5_000;
const LEASE_MS = 30_000;
const MAX_PENDING = 1_000;
const MAX_ATTEMPTS = 3;
const RECONCILIATION_BATCH = 50;
const CURSOR_ID = "post-call";
const retryableCodes = new Set(["TIMEOUT", "RATE_LIMITED", "PROVIDER_UNAVAILABLE"]);

export type AutomaticAssessmentConfig = {
  enabled: boolean;
  startAt: Date | null;
  reason: "DISABLED" | "MISSING_START_AT" | "INVALID_START_AT" | null;
};

export function readAutomaticAssessmentConfig(env = process.env): AutomaticAssessmentConfig {
  if (env.JEV_AUTO_POST_CALL_ENABLED !== "true") return { enabled: false, startAt: null, reason: "DISABLED" };
  const raw = env.JEV_AUTO_START_AT?.trim();
  if (!raw) return { enabled: false, startAt: null, reason: "MISSING_START_AT" };
  const at = new Date(raw);
  if (!Number.isFinite(at.getTime()) || !/^\d{4}-\d\d-\d\dT/.test(raw)) return { enabled: false, startAt: null, reason: "INVALID_START_AT" };
  return { enabled: true, startAt: at, reason: null };
}

function automaticEnabled() {
  const automatic = readAutomaticAssessmentConfig();
  const manual = capabilityFor(readJevConfig());
  return { automatic, available: automatic.enabled && manual.available };
}

async function ensureSlots(tx: Prisma.TransactionClient) {
  await Promise.all([0, 1].map((slot) => tx.assessmentWorkerSlot.upsert({ where: { slot }, create: { slot }, update: {} })));
}

async function lockAdmission(tx: Prisma.TransactionClient) {
  await ensureSlots(tx);
  // Slot 0 is also the short-lived queue-admission mutex. Holding it only
  // through this transaction serializes count+upsert without consuming a run.
  await tx.assessmentWorkerSlot.update({ where: { slot: 0 }, data: { updatedAt: new Date() } });
}

function isEligibleForAutomatic(
  call: Awaited<ReturnType<typeof readAssessmentSnapshot>>,
  startAt: Date
) {
  if (!call || !call.endedAt || call.endedAt < startAt) return null;
  const snapshot = buildAssessmentSnapshot(call);
  return snapshot.eligibility.eligible ? snapshot : null;
}

/** Must be called in the same transaction as the state mutation it observes. */
export async function markPostCallAssessmentDirty(tx: Prisma.TransactionClient, callId: string, now: Date): Promise<void> {
  const { automatic, available } = automaticEnabled();
  if (!available || !automatic.startAt) return;
  const snapshot = isEligibleForAutomatic(await readAssessmentSnapshot(tx, callId), automatic.startAt);
  if (!snapshot) return;
  await lockAdmission(tx);
  const existing = await tx.assessmentJob.findUnique({ where: { callId_kind: { callId, kind: "POST_CALL" } } });
  const dueAt = new Date(now.getTime() + SETTLE_MS);
  if (existing) {
    // Replaying an identical final turn must not reset the automatic retry
    // budget. New evidence changes the normalized input hash and is the only
    // reason to start a new generation.
    if (existing.lastInputHash === snapshot.inputHash) return;
    const inactive = existing.state !== "PENDING" && existing.state !== "RUNNING";
    const activeCount = inactive
      ? await tx.assessmentJob.count({ where: { state: { in: ["PENDING", "RUNNING"] } } })
      : 0;
    const admit = !inactive || activeCount < MAX_PENDING;
    await tx.assessmentJob.update({
      where: { id: existing.id },
      data: {
        generation: { increment: 1 },
        attempts: 0,
        lastInputHash: snapshot.inputHash,
        dueAt,
        reason: null,
        ...(existing.state === "RUNNING" ? {} : admit
          ? { state: "PENDING", claimedGeneration: null, leaseToken: null, leaseExpiresAt: null }
          : { state: "SKIPPED", reason: "QUEUE_CAPACITY", claimedGeneration: null, leaseToken: null, leaseExpiresAt: null })
      }
    });
    return;
  }
  const pending = await tx.assessmentJob.count({ where: { state: { in: ["PENDING", "RUNNING"] } } });
  await tx.assessmentJob.create({
    data: {
      callId,
      kind: "POST_CALL",
      state: pending >= MAX_PENDING ? "SKIPPED" : "PENDING",
      generation: 1,
      dueAt,
      lastInputHash: snapshot.inputHash,
      reason: pending >= MAX_PENDING ? "QUEUE_CAPACITY" : null,
      source: "AUTO_POST_CALL"
    }
  });
}

type ClaimedWork = {
  job: { id: string; callId: string; generation: number; attempts: number; lastInputHash: string | null; leaseToken: string | null; leaseExpiresAt: Date | null };
  slot: number;
  token: string;
};

async function claimWorkOnce(eligibleAt: Date, now: Date, excludedCallIds: string[] = []): Promise<ClaimedWork | null> {
  const token = randomUUID();
  return prisma.$transaction(async (tx) => {
    await ensureSlots(tx);
    const expired = await tx.assessmentJob.findMany({
      where: { state: "RUNNING", leaseExpiresAt: { lte: now } },
      select: { id: true }
    });
    if (expired.length) await tx.assessmentJob.updateMany({
      where: { id: { in: expired.map((job) => job.id) }, state: "RUNNING", leaseExpiresAt: { lte: now } },
      data: { state: "PENDING", dueAt: now, claimedGeneration: null, leaseToken: null, leaseExpiresAt: null, reason: "LEASE_EXPIRED" }
    });
    const free = await tx.assessmentWorkerSlot.findFirst({
      where: { OR: [{ ownerToken: null }, { leaseExpiresAt: { lte: now } }] },
      orderBy: { slot: "asc" }
    });
    if (!free) return null;
    const slotClaimed = await tx.assessmentWorkerSlot.updateMany({
      where: { slot: free.slot, OR: [{ ownerToken: null }, { leaseExpiresAt: { lte: now } }] },
      data: { ownerToken: token, jobId: null, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }
    });
    if (slotClaimed.count !== 1) return null;
    const candidate = await tx.assessmentJob.findFirst({
      where: { state: "PENDING", dueAt: { lte: eligibleAt }, ...(excludedCallIds.length ? { callId: { notIn: excludedCallIds } } : {}) },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }]
    });
    if (!candidate) {
      await tx.assessmentWorkerSlot.updateMany({ where: { slot: free.slot, ownerToken: token }, data: { ownerToken: null, jobId: null, leaseExpiresAt: null } });
      return null;
    }
    const claimed = await tx.assessmentJob.updateMany({
      where: { id: candidate.id, state: "PENDING", generation: candidate.generation, dueAt: { lte: eligibleAt } },
      data: { state: "RUNNING", claimedGeneration: candidate.generation, leaseToken: token, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), reason: null }
    });
    if (claimed.count !== 1) {
      await tx.assessmentWorkerSlot.updateMany({ where: { slot: free.slot, ownerToken: token }, data: { ownerToken: null, jobId: null, leaseExpiresAt: null } });
      return null;
    }
    await tx.assessmentWorkerSlot.updateMany({ where: { slot: free.slot, ownerToken: token }, data: { jobId: candidate.id } });
    return { job: { ...candidate, leaseToken: token, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) }, slot: free.slot, token };
  });
}

async function claimWork(eligibleAt: Date, now: Date, excludedCallIds: string[] = []): Promise<ClaimedWork | null> {
  // Serializable claims may conflict when independent workers race for the
  // same slot. Retry the short transaction; no provider request has started.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await claimWorkOnce(eligibleAt, new Date(), excludedCallIds);
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  return null;
}

async function releaseWork(work: ClaimedWork, data: {
  state: "PENDING" | "SUCCEEDED" | "FAILED";
  dueAt?: Date;
  reason?: string | null;
  replaceInputHash?: string;
  releaseReservation?: boolean;
}) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const current = await tx.assessmentJob.findUnique({ where: { id: work.job.id } });
    if (!current || current.state !== "RUNNING" || current.leaseToken !== work.token || current.claimedGeneration !== work.job.generation) return;
    const dirty = current.generation !== work.job.generation;
    const next = dirty ? {
      state: "PENDING" as const, dueAt: new Date(now.getTime() + SETTLE_MS), reason: null,
      claimedGeneration: null, leaseToken: null, leaseExpiresAt: null
    } : data.replaceInputHash ? {
      state: "PENDING" as const, dueAt: data.dueAt ?? new Date(now.getTime() + SETTLE_MS), reason: null,
      claimedGeneration: null, leaseToken: null, leaseExpiresAt: null,
      generation: { increment: 1 }, attempts: 0, lastInputHash: data.replaceInputHash
    } : {
      state: data.state, dueAt: data.dueAt ?? current.dueAt, reason: data.reason ?? null,
      claimedGeneration: null, leaseToken: null, leaseExpiresAt: null,
      ...(data.releaseReservation ? { attempts: { decrement: 1 } } : {})
    };
    const updated = await tx.assessmentJob.updateMany({
      // Fence against a dirty write between the read and this transition.
      where: { id: current.id, state: "RUNNING", leaseToken: work.token, claimedGeneration: work.job.generation, generation: work.job.generation },
      data: next
    });
    if (updated.count === 0 && dirty) {
      // A late transcript/ticket changed generation while the provider was in
      // flight. Preserve that generation and requeue it; never overwrite it
      // with the stale result.
      await tx.assessmentJob.updateMany({
        where: { id: current.id, state: "RUNNING", leaseToken: work.token },
        data: { state: "PENDING", dueAt: new Date(now.getTime() + SETTLE_MS), reason: null, claimedGeneration: null, leaseToken: null, leaseExpiresAt: null }
      });
    }
    if (updated.count === 1 || dirty) await tx.assessmentWorkerSlot.updateMany({
      where: { slot: work.slot, ownerToken: work.token, jobId: work.job.id },
      data: { ownerToken: null, jobId: null, leaseExpiresAt: null }
    });
  });
}

type ProviderReservation =
  | { outcome: "RESERVED"; attempt: number }
  | { outcome: "STALE" }
  | { outcome: "LEASE_LOST" }
  | { outcome: "EXHAUSTED" };

async function reserveProviderAttempt(work: ClaimedWork, expectedInputHash: string): Promise<ProviderReservation> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const call = await readAssessmentSnapshot(tx, work.job.callId);
    if (!call) return { outcome: "STALE" };
    const snapshot = buildAssessmentSnapshot(call);
    if (!snapshot.eligibility.eligible || snapshot.inputHash !== expectedInputHash) return { outcome: "STALE" };
    const expiresAt = new Date(now.getTime() + LEASE_MS);
    const slot = await tx.assessmentWorkerSlot.updateMany({
      where: { slot: work.slot, ownerToken: work.token, jobId: work.job.id, leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt: expiresAt }
    });
    if (slot.count !== 1) return { outcome: "LEASE_LOST" };
    const reserved = await tx.assessmentJob.updateMany({
      where: {
        id: work.job.id, state: "RUNNING", leaseToken: work.token,
        claimedGeneration: work.job.generation, generation: work.job.generation,
        leaseExpiresAt: { gt: now }, attempts: { lt: MAX_ATTEMPTS }
      },
      data: { attempts: { increment: 1 }, leaseExpiresAt: expiresAt }
    });
    if (reserved.count === 1) return { outcome: "RESERVED", attempt: work.job.attempts + 1 };
    const current = await tx.assessmentJob.findUnique({
      where: { id: work.job.id },
      select: { state: true, leaseToken: true, claimedGeneration: true, generation: true, attempts: true }
    });
    if (
      current?.state === "RUNNING" && current.leaseToken === work.token &&
      current.claimedGeneration === work.job.generation && current.generation === work.job.generation &&
      current.attempts >= MAX_ATTEMPTS
    ) return { outcome: "EXHAUSTED" };
    return { outcome: "LEASE_LOST" };
  });
}

async function renewLaunchLease(work: ClaimedWork, expectedInputHash: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const call = await readAssessmentSnapshot(tx, work.job.callId);
    if (!call) return false;
    const snapshot = buildAssessmentSnapshot(call);
    if (!snapshot.eligibility.eligible || snapshot.inputHash !== expectedInputHash) return false;
    const expiresAt = new Date(now.getTime() + LEASE_MS);
    const job = await tx.assessmentJob.updateMany({
      where: { id: work.job.id, state: "RUNNING", leaseToken: work.token, claimedGeneration: work.job.generation, generation: work.job.generation, leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt: expiresAt }
    });
    if (job.count !== 1) return false;
    const slot = await tx.assessmentWorkerSlot.updateMany({
      where: { slot: work.slot, ownerToken: work.token, jobId: work.job.id, leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt: expiresAt }
    });
    return slot.count === 1;
  });
}

async function processWork(work: ClaimedWork, now: Date): Promise<void> {
  const { automatic, available } = automaticEnabled();
  if (!available || !automatic.startAt) return releaseWork(work, { state: "FAILED", reason: automatic.reason ?? "ASSESSMENT_UNAVAILABLE" });
  const call = await readAssessmentSnapshot(prisma, work.job.callId);
  const snapshot = isEligibleForAutomatic(call, automatic.startAt);
  if (!snapshot || !snapshot.inputHash) return releaseWork(work, { state: "FAILED", reason: "NO_LONGER_ELIGIBLE" });
  const inputHash = snapshot.inputHash;
  if (work.job.lastInputHash && work.job.lastInputHash !== snapshot.inputHash) {
    return releaseWork(work, { state: "PENDING", dueAt: new Date(now.getTime() + SETTLE_MS), replaceInputHash: snapshot.inputHash });
  }
  const existing = await prisma.callAssessment.findUnique({ where: { callId_inputHash_requestedModel_rubricVersion: { callId: work.job.callId, inputHash, requestedModel: "jev-1.13.0", rubricVersion: "msva-post-call-v2" } } });
  if (existing?.status === "SUCCEEDED") return releaseWork(work, { state: "SUCCEEDED", reason: null });
  if (existing?.status === "RUNNING" && existing.leaseExpiresAt && existing.leaseExpiresAt > now) {
    return releaseWork(work, { state: "PENDING", dueAt: existing.leaseExpiresAt, reason: "ASSESSMENT_LEASE_ACTIVE" });
  }
  // Reserve before the request can reach the provider. A crash after this
  // point is conservatively charged to the immutable snapshot's three-attempt
  // budget, so restart recovery cannot create an unbounded provider loop.
  const attempt = await reserveProviderAttempt(work, inputHash);
  if (attempt.outcome === "STALE") return releaseWork(work, { state: "PENDING", dueAt: new Date(Date.now() + SETTLE_MS), replaceInputHash: snapshot.inputHash });
  if (attempt.outcome === "LEASE_LOST") return releaseWork(work, { state: "PENDING", dueAt: new Date(Date.now() + SETTLE_MS), reason: "LEASE_LOST" });
  if (attempt.outcome === "EXHAUSTED") return releaseWork(work, { state: "FAILED", reason: "MAX_ATTEMPTS" });
  const result = await requestCallAssessment(work.job.callId, null, {
    trigger: "AUTO_POST_CALL", expectedInputHash: inputHash,
    beforeInvoke: () => renewLaunchLease(work, inputHash)
  });
  if (result.stale) return releaseWork(work, { state: "PENDING", dueAt: new Date(now.getTime() + SETTLE_MS), reason: null, releaseReservation: true });
  if (result.pending) {
    const lease = result.response?.assessment?.leaseExpiresAt;
    return releaseWork(work, { state: "PENDING", dueAt: lease ? new Date(lease) : new Date(now.getTime() + SETTLE_MS), reason: "ASSESSMENT_LEASE_ACTIVE", releaseReservation: true });
  }
  const assessment = result.response?.assessment;
  if (assessment?.status === "SUCCEEDED" && result.response?.current) return releaseWork(work, { state: "SUCCEEDED", reason: null, releaseReservation: !result.invoked });
  const code = assessment?.errorCode ?? "PROVIDER_UNAVAILABLE";
  if (!result.invoked) return releaseWork(work, { state: "PENDING", dueAt: new Date(now.getTime() + 30_000), reason: code, releaseReservation: true });
  if (retryableCodes.has(code) && attempt.attempt < MAX_ATTEMPTS) {
    const retryDelay = attempt.attempt === 1 ? 30_000 : 120_000;
    return releaseWork(work, { state: "PENDING", dueAt: new Date(now.getTime() + retryDelay), reason: code });
  }
  return releaseWork(work, { state: "FAILED", reason: code });
}

export async function reconcileAssessmentJobs(now = new Date()): Promise<number> {
  const { automatic, available } = automaticEnabled();
  if (!available || !automatic.startAt) return 0;
  const cursor = await prisma.assessmentReconciliationCursor.upsert({ where: { id: CURSOR_ID }, create: { id: CURSOR_ID }, update: {} });
  const calls = await prisma.call.findMany({
    where: {
      status: "COMPLETED", endedAt: { gte: automatic.startAt },
      ...(cursor.endedAt ? { OR: [{ endedAt: { gt: cursor.endedAt } }, { endedAt: cursor.endedAt, id: { gt: cursor.callId ?? "" } }] } : {})
    },
    select: { id: true, endedAt: true }, orderBy: [{ endedAt: "asc" }, { id: "asc" }], take: RECONCILIATION_BATCH
  });
  if (!calls.length) {
    await prisma.assessmentReconciliationCursor.update({ where: { id: CURSOR_ID }, data: { endedAt: null, callId: null } });
    return 0;
  }
  let repaired = 0;
  for (const call of calls) {
    await prisma.$transaction(async (tx) => {
      const snapshot = isEligibleForAutomatic(await readAssessmentSnapshot(tx, call.id), automatic.startAt!);
      if (!snapshot?.inputHash) return;
      const job = await tx.assessmentJob.findUnique({ where: { callId_kind: { callId: call.id, kind: "POST_CALL" } } });
      if (!job || job.lastInputHash !== snapshot.inputHash) {
        await markPostCallAssessmentDirty(tx, call.id, now);
        repaired++;
      }
    });
  }
  const last = calls.at(-1)!;
  await prisma.assessmentReconciliationCursor.update({ where: { id: CURSOR_ID }, data: { endedAt: last.endedAt, callId: last.id } });
  return repaired;
}

export async function runAssessmentTick(now = new Date()): Promise<{ claimed: number; completed: number }> {
  await reconcileAssessmentJobs(now);
  let claimed = 0;
  let completed = 0;
  const claimedCallIds: string[] = [];
  // A process can claim at most two, and the persisted slots cap all processes.
  for (let index = 0; index < 2; index++) {
    let work: ClaimedWork | null = null;
    try {
      // Reconciliation can be slow. Never derive a lease from the tick's
      // start timestamp; each claim gets a fresh wall-clock lease.
      work = await claimWork(now, new Date(), claimedCallIds);
      if (!work) break;
      claimed++;
      claimedCallIds.push(work.job.callId);
      await processWork(work, new Date());
      completed++;
    } catch {
      if (work) await releaseWork(work, { state: "PENDING", dueAt: new Date(now.getTime() + 30_000), reason: "PROVIDER_UNAVAILABLE" });
    }
  }
  return { claimed, completed };
}
