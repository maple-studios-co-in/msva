import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import express from "express";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@msva/db";
import { revokeSession } from "./auth.js";
import { adminRouter } from "./routes/admin.js";
import { authorizeSignalConnection, claimMediaControlIntent, claimVoiceLease, confirmSignalParticipant, CONTROL_DEGRADED_ATTEMPTS, createVoiceSession, degradedMediaControls, finishMediaControlIntent, prepareBrowserAdmission, recordVoiceDispatch, renewSignalConnection, workerParticipantIdentity } from "./voiceService.js";

const databaseUrl = process.env.MSVA_VOICE_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("MSVA_VOICE_TEST_DATABASE_URL is required");
process.env.VOICE_ENABLED = "true";
process.env.VOICE_WORKER_API_TOKEN = "worker-test-token";
process.env.VOICE_LEASE_SIGNING_KEY = "voice-test-signing-key";
process.env.VOICE_BROWSER_ORIGIN = "https://console.test";
const db = new PrismaClient({ datasourceUrl: databaseUrl });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

beforeEach(async () => { await db.$executeRawUnsafe('TRUNCATE TABLE "ToolInvocation", "MediaControlIntent", "VoiceAdmission", "TranscriptSegment", "VoiceEvent", "VoiceLease", "VoiceParticipant", "VoiceSession", "Handoff", "AuditLog", "Session", "User", "Call" CASCADE'); });
afterAll(() => db.$disconnect());

async function liveCall() {
  const callId = `voice-${randomUUID()}`;
  await db.call.create({ data: { id: callId, provider: "BROWSER", isTest: true, fromNumber: "browser" } });
  const session = await createVoiceSession({ requestId: `request-${callId}`, callId, callerParticipantId: "caller", language: "hi" }, db);
  await recordVoiceDispatch(session.id, "dispatch", db);
  await claimVoiceLease({ callId, roomName: session.roomName, dispatchId: "dispatch", participantId: workerParticipantIdentity(callId) }, "Bearer worker-test-token", db);
  return { callId, sessionId: session.id, roomName: session.roomName };
}
async function staff(role: "AGENT" | "ADMIN" = "AGENT") {
  const token = randomBytes(32).toString("hex");
  const user = await db.user.create({ data: { email: `${randomUUID()}@test.invalid`, name: "Staff", role } });
  const browser = await db.session.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { user, browser, token };
}
type Call = Awaited<ReturnType<typeof liveCall>>;
type Staff = Awaited<ReturnType<typeof staff>>;
async function listener(call: Call, who: Staff) {
  await db.handoff.create({ data: { callId: call.callId, assignedUserId: who.user.id, state: "ASSIGNED" } });
  return prepareBrowserAdmission({ callId: call.callId, userId: who.user.id, sessionId: who.browser.id, role: "OPERATOR_LISTENER", expectedAuthorizationVersion: 1 }, db);
}
const connect = (call: Call, who: Staff, participantIdentity: string, grants: { publish: boolean; subscribe: boolean } = { publish: false, subscribe: false }, protocol: "v0" | "v1" = "v1") =>
  authorizeSignalConnection({ tokenClaims: { subject: participantIdentity, room: call.roomName, roomJoin: true, ...grants }, sessionTokenHash: sha256(who.token), origin: "https://console.test", protocol, reconnect: false, participantSid: null }, db);
const removals = (admissionId: string) => db.mediaControlIntent.count({ where: { admissionId, kind: "REMOVE" } });
const lockWaiter = () => vi.waitFor(async () => {
  const [row] = await db.$queryRaw<{ waiting: bigint }[]>`SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  expect(Number(row!.waiting)).toBeGreaterThan(0);
}, { timeout: 5_000, interval: 20 });
/** Lets a control whose retry is scheduled later run now, as if the wait had passed. */
const due = (id: string) => db.mediaControlIntent.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });

describe("connection renewal", () => {
  const lapses: Array<[string, (call: Call, who: Staff, admissionId: string) => Promise<unknown>]> = [
    ["the login session is gone", (_call, who) => db.session.delete({ where: { id: who.browser.id } })],
    ["the login session expired", (_call, who) => db.session.update({ where: { id: who.browser.id }, data: { expiresAt: new Date(Date.now() - 1) } })],
    ["the user was disabled", (_call, who) => db.user.update({ where: { id: who.user.id }, data: { active: false } })],
    ["the user became a viewer", (_call, who) => db.user.update({ where: { id: who.user.id }, data: { role: "VIEWER" } })],
    ["the assignment ended", (call) => db.handoff.updateMany({ where: { callId: call.callId }, data: { state: "FAILED" } })],
    ["the admission reached its absolute expiry", (_call, _who, admissionId) => db.voiceAdmission.update({ where: { id: admissionId }, data: { absoluteExpiresAt: new Date(Date.now() - 1) } })],
    ["the call ended", (call) => db.voiceSession.update({ where: { id: call.sessionId }, data: { state: "ENDED" } })]
  ];
  it.each(lapses)("revokes a live connection when %s", async (_label, lapse) => {
    const call = await liveCall(); const who = await staff();
    const admission = await listener(call, who);
    const connection = await connect(call, who, admission.participantIdentity);
    await expect(renewSignalConnection(connection, db)).resolves.toMatchObject({ connectionLeaseExpiresAt: expect.any(Date) });
    await lapse(call, who, admission.id);
    await expect(renewSignalConnection(connection, db)).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });
    expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: admission.id } })).toMatchObject({ state: "REVOKING" });
    expect(await removals(admission.id)).toBe(1);
  });

  it.each(["renewal", "SID confirmation"] as const)("judges the connection lease by the time after waiting for its lock (%s)", async (action) => {
    const call = await liveCall(); const who = await staff();
    const admission = await listener(call, who);
    const connection = await connect(call, who, admission.participantIdentity);
    await db.voiceAdmission.update({ where: { id: admission.id }, data: { connectionLeaseExpiresAt: new Date(Date.now() + 300) } });
    let pending!: Promise<unknown>;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "VoiceAdmission" WHERE "id" = ${admission.id} FOR UPDATE`;
      pending = action === "renewal" ? renewSignalConnection(connection, db) : confirmSignalParticipant({ ...connection, participantSid: "PA_late" }, db);
      await lockWaiter();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }, { timeout: 15_000 });
    await expect(pending).rejects.toMatchObject({ code: "CONNECTION_STALE" });
    const after = await db.voiceAdmission.findUniqueOrThrow({ where: { id: admission.id } });
    expect(after.participantSid).toBeNull();
    expect(after.connectionLeaseExpiresAt!.getTime()).toBeLessThan(Date.now());
  });

  it("keeps the caller admitted while the call waits for staff recovery", async () => {
    const call = await liveCall(); const who = await staff();
    await db.voiceSession.update({ where: { id: call.sessionId }, data: { ownerUserId: who.user.id, ownerSessionId: who.browser.id } });
    const admission = await prepareBrowserAdmission({ callId: call.callId, userId: who.user.id, sessionId: who.browser.id, role: "CALLER", expectedAuthorizationVersion: 1 }, db);
    const connection = await connect(call, who, admission.participantIdentity);
    await db.voiceSession.update({ where: { id: call.sessionId }, data: { state: "RECOVERY_REQUIRED" } });
    await expect(renewSignalConnection(connection, db)).resolves.toMatchObject({ connectionLeaseExpiresAt: expect.any(Date) });
  });
});

describe("revocation hooks", () => {
  it("revokes browser media admitted under a login when it logs out", async () => {
    const call = await liveCall(); const who = await staff();
    const admission = await listener(call, who);
    await revokeSession(who.token);
    expect(await db.session.count({ where: { id: who.browser.id } })).toBe(0);
    expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: admission.id } })).toMatchObject({ state: "REVOKING", revokeReason: "LOGOUT" });
    expect(await removals(admission.id)).toBe(1);
  });

  it("revokes a user's admissions when an admin disables them or changes their role", async () => {
    const admin = await staff("ADMIN");
    const app = express(); app.use(express.json()); app.use("/api/admin", adminRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const patch = (userId: string, body: object) => fetch(`http://127.0.0.1:${port}/api/admin/users/${userId}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: `msva_session=${admin.token}` }, body: JSON.stringify(body) });
    try {
      // One active handoff per call, so each operator is assigned their own call.
      const demoted = await staff(); const demotedAdmission = await listener(await liveCall(), demoted);
      expect((await patch(demoted.user.id, { role: "VIEWER" })).status).toBe(200);
      expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: demotedAdmission.id } })).toMatchObject({ state: "REVOKING", revokeReason: "ROLE_CHANGED" });
      const disabled = await staff(); const disabledAdmission = await listener(await liveCall(), disabled);
      expect((await patch(disabled.user.id, { active: false })).status).toBe(200);
      expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: disabledAdmission.id } })).toMatchObject({ state: "REVOKING", revokeReason: "USER_DISABLED" });
      expect(await db.session.count({ where: { userId: disabled.user.id } })).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("signal admission", () => {
  it("accepts a join-only first token and later grants within the role, over both protocols", async () => {
    const call = await liveCall(); const who = await staff();
    const admission = await listener(call, who);
    await expect(connect(call, who, admission.participantIdentity, { publish: true, subscribe: false })).rejects.toMatchObject({ code: "ADMISSION_DENIED" });
    await expect(connect(call, who, admission.participantIdentity, { publish: false, subscribe: true })).rejects.toMatchObject({ code: "ADMISSION_DENIED" });
    const first = await connect(call, who, admission.participantIdentity, { publish: false, subscribe: false }, "v0");
    await renewSignalConnection(first, db);
    await db.voiceAdmission.update({ where: { id: admission.id }, data: { connectionLeaseExpiresAt: new Date(Date.now() - 1) } });
    // A listener may subscribe but never publish, even with a refreshed token.
    await expect(connect(call, who, admission.participantIdentity, { publish: true, subscribe: true })).rejects.toMatchObject({ code: "ADMISSION_DENIED" });
    await expect(connect(call, who, admission.participantIdentity, { publish: false, subscribe: true })).resolves.toMatchObject({ admissionId: admission.id });
  });

  it("refuses another browser session without revoking the owner's admission", async () => {
    const call = await liveCall(); const who = await staff(); const other = await staff();
    const admission = await listener(call, who);
    await expect(connect(call, other, admission.participantIdentity)).rejects.toMatchObject({ code: "ADMISSION_DENIED" });
    expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: admission.id } })).toMatchObject({ state: "ISSUED" });
    await expect(connect(call, who, admission.participantIdentity)).resolves.toMatchObject({ admissionId: admission.id });
  });

  it("reads the clock after waiting for the admission lock", async () => {
    const call = await liveCall(); const who = await staff();
    const admission = await listener(call, who);
    await db.voiceAdmission.update({ where: { id: admission.id }, data: { firstJoinExpiresAt: new Date(Date.now() + 300) } });
    let connecting!: ReturnType<typeof connect>;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "VoiceAdmission" WHERE "id" = ${admission.id} FOR UPDATE`;
      connecting = connect(call, who, admission.participantIdentity);
      await vi.waitFor(async () => {
        const [row] = await db.$queryRaw<{ waiting: bigint }[]>`SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        expect(Number(row!.waiting)).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 20 });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }, { timeout: 15_000 });
    await expect(connecting).rejects.toMatchObject({ code: "ADMISSION_DENIED" });
  });

  it("records the participant SID so the same connection can resume", async () => {
    const call = await liveCall(); const who = await staff();
    const admission = await listener(call, who);
    const connection = await connect(call, who, admission.participantIdentity);
    await confirmSignalParticipant({ ...connection, participantSid: "PA_first" }, db);
    await db.voiceAdmission.update({ where: { id: admission.id }, data: { connectionLeaseExpiresAt: new Date(Date.now() - 1) } });
    const resume = (participantSid: string) => authorizeSignalConnection({ tokenClaims: { subject: admission.participantIdentity, room: call.roomName, roomJoin: true, publish: false, subscribe: false }, sessionTokenHash: sha256(who.token), origin: "https://console.test", protocol: "v1", reconnect: true, participantSid }, db);
    await expect(resume("PA_other")).rejects.toMatchObject({ code: "RECONNECT_MISMATCH" });
    await expect(resume("PA_first")).resolves.toMatchObject({ connectionEpoch: 2 });
  });
});

describe("admission preparation", () => {
  it("replaces an unused, lapsed operator admission with a fresh identity", async () => {
    const call = await liveCall(); const who = await staff();
    const first = await listener(call, who);
    await db.voiceAdmission.update({ where: { id: first.id }, data: { firstJoinExpiresAt: new Date(Date.now() - 1) } });
    const second = await prepareBrowserAdmission({ callId: call.callId, userId: who.user.id, sessionId: who.browser.id, role: "OPERATOR_LISTENER", expectedAuthorizationVersion: 1 }, db);
    expect(second.id).not.toBe(first.id);
    expect(second.participantIdentity).not.toBe(first.participantIdentity);
    expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ state: "EXPIRED" });
  });

  it("re-arms an unused caller admission but never re-admits a revoked caller", async () => {
    const call = await liveCall(); const who = await staff();
    await db.voiceSession.update({ where: { id: call.sessionId }, data: { ownerUserId: who.user.id, ownerSessionId: who.browser.id } });
    const input = { callId: call.callId, userId: who.user.id, sessionId: who.browser.id, role: "CALLER" as const, expectedAuthorizationVersion: 1 };
    const first = await prepareBrowserAdmission(input, db);
    await db.voiceAdmission.update({ where: { id: first.id }, data: { firstJoinExpiresAt: new Date(Date.now() - 1) } });
    const rearmed = await prepareBrowserAdmission(input, db);
    expect(rearmed.id).toBe(first.id);
    expect(rearmed.firstJoinExpiresAt.getTime()).toBeGreaterThan(Date.now());
    await db.voiceAdmission.update({ where: { id: first.id }, data: { state: "REVOKED" } });
    await expect(prepareBrowserAdmission(input, db)).rejects.toMatchObject({ status: 409, code: "CALLER_ADMISSION_CLOSED" });
  });
});

describe("media control execution", () => {
  it("reclaims a lapsed attempt with a new token and retries a failed removal", async () => {
    const call = await liveCall(); const who = await staff();
    const admission = await listener(call, who);
    await revokeSession(who.token);
    const attempt = await claimMediaControlIntent(db);
    expect(attempt).toMatchObject({ admissionId: admission.id, kind: "REMOVE" });
    await db.mediaControlIntent.update({ where: { id: attempt!.id }, data: { leaseExpiresAt: new Date(Date.now() - 1) } });
    const retry = await claimMediaControlIntent(db);
    expect(retry).toMatchObject({ id: attempt!.id });
    expect(retry!.attemptToken).not.toBe(attempt!.attemptToken);
    await expect(finishMediaControlIntent({ id: attempt!.id, attemptToken: attempt!.attemptToken, success: true }, db)).rejects.toMatchObject({ code: "CONTROL_ATTEMPT_STALE" });
    await finishMediaControlIntent({ id: retry!.id, attemptToken: retry!.attemptToken, success: false, errorCode: "SFU_UNAVAILABLE" }, db);
    expect(await db.mediaControlIntent.findUniqueOrThrow({ where: { id: attempt!.id } })).toMatchObject({ status: "PENDING", errorCode: "SFU_UNAVAILABLE" });
    // The failed removal waits before its next attempt.
    expect(await claimMediaControlIntent(db)).toBeNull();
    await due(attempt!.id);
    const again = await claimMediaControlIntent(db);
    await finishMediaControlIntent({ id: again!.id, attemptToken: again!.attemptToken, success: true }, db);
    expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: admission.id } })).toMatchObject({ state: "REVOKED" });
  });

  it("keeps removing other participants' media while one removal keeps failing", async () => {
    const failing = await staff(); const other = await staff();
    const failingAdmission = await listener(await liveCall(), failing);
    const otherAdmission = await listener(await liveCall(), other);
    await revokeSession(failing.token);
    await revokeSession(other.token);
    const first = await claimMediaControlIntent(db);
    expect(first).toMatchObject({ admissionId: failingAdmission.id, kind: "REMOVE" });
    await finishMediaControlIntent({ id: first!.id, attemptToken: first!.attemptToken, success: false, errorCode: "SFU_UNAVAILABLE" }, db);
    const next = await claimMediaControlIntent(db);
    expect(next).toMatchObject({ admissionId: otherAdmission.id, kind: "REMOVE" });
    await finishMediaControlIntent({ id: next!.id, attemptToken: next!.attemptToken, success: true }, db);
    expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: otherAdmission.id } })).toMatchObject({ state: "REVOKED" });

    // Each further failure waits longer, and repeated failures are surfaced.
    let wait = 0;
    for (let attempt = 2; attempt <= CONTROL_DEGRADED_ATTEMPTS; attempt += 1) {
      await due(first!.id);
      const retry = await claimMediaControlIntent(db);
      expect(retry).toMatchObject({ id: first!.id });
      await finishMediaControlIntent({ id: retry!.id, attemptToken: retry!.attemptToken, success: false, errorCode: "SFU_UNAVAILABLE" }, db);
      const scheduled = (await db.mediaControlIntent.findUniqueOrThrow({ where: { id: first!.id } })).nextAttemptAt.getTime() - Date.now();
      expect(scheduled).toBeGreaterThan(wait);
      wait = scheduled;
    }
    expect(await degradedMediaControls(db)).toEqual([expect.objectContaining({ id: first!.id, admissionId: failingAdmission.id, attempts: CONTROL_DEGRADED_ATTEMPTS })]);
    await due(first!.id);
    const recovered = await claimMediaControlIntent(db);
    await finishMediaControlIntent({ id: recovered!.id, attemptToken: recovered!.attemptToken, success: true }, db);
    expect(await db.voiceAdmission.findUniqueOrThrow({ where: { id: failingAdmission.id } })).toMatchObject({ state: "REVOKED" });
    expect(await degradedMediaControls(db)).toEqual([]);
  });

  it("holds a grant until its participant's connection is confirmed and live", async () => {
    const call = await liveCall(); const who = await staff();
    const admission = await listener(call, who);
    const grant = await db.mediaControlIntent.create({ data: { admissionId: admission.id, authorizationVersion: 1, kind: "GRANT" } });
    expect(await claimMediaControlIntent(db)).toBeNull();
    const connection = await connect(call, who, admission.participantIdentity);
    await renewSignalConnection(connection, db);
    await due(grant.id);
    // Connected, but the participant's SID is not confirmed yet.
    expect(await claimMediaControlIntent(db)).toBeNull();
    await confirmSignalParticipant({ ...connection, participantSid: "PA_listener" }, db);
    await due(grant.id);
    expect(await claimMediaControlIntent(db)).toMatchObject({ id: grant.id, kind: "GRANT" });
    expect(await db.mediaControlIntent.findUniqueOrThrow({ where: { id: grant.id } })).toMatchObject({ status: "RUNNING", attempts: 1 });
  });
});
