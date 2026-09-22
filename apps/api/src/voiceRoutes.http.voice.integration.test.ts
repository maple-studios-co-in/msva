import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { PrismaClient } from "@msva/db";
import { WorkerEventSchema } from "@msva/contracts";
import { createVoiceSession, recordVoiceDispatch, workerParticipantIdentity } from "./voiceService.js";
import { voiceRouter } from "./voiceRoutes.js";
import { internalRouter } from "./routes/internal.js";
import runtimeReplayCorpus from "./fixtures/voice-v1-replay-corpus.json" with { type: "json" };

const databaseUrl = process.env.MSVA_VOICE_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("MSVA_VOICE_TEST_DATABASE_URL is required");
process.env.VOICE_ENABLED = "true";
process.env.VOICE_WORKER_API_TOKEN = "worker-test-token";
process.env.VOICE_LEASE_SIGNING_KEY = "voice-test-signing-key";
const db = new PrismaClient({ datasourceUrl: databaseUrl });

const app = express();
app.use(express.json());
app.use("/api/internal/voice/v1", voiceRouter);
// Keep the production mount order: legacy internal authentication must never
// intercept a scoped worker credential before the voice router sees it.
app.use("/api/internal", internalRouter);
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("voice test listener did not bind");
const baseUrl = `http://127.0.0.1:${address.port}/api/internal/voice/v1`;

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "ToolInvocation", "MediaControlIntent", "VoiceAdmission", "TranscriptSegment", "VoiceEvent", "VoiceLease", "VoiceParticipant", "VoiceSession", "Session", "User", "Call" CASCADE');
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await db.$disconnect(); });

describe("voice worker mounted HTTP contract", () => {
  it("accepts the runtime ready1/final2/flushed3 wire stream through the mounted router", async () => {
    const callId = `voice-${randomUUID()}`;
    await db.call.create({ data: { id: callId, provider: "BROWSER", isTest: true, fromNumber: "browser" } });
    const session = await createVoiceSession({ requestId: `request-${callId}`, callId, callerParticipantId: "caller", language: "en" }, db);
    await recordVoiceDispatch(session.id, "provider-dispatch-id", db);
    const leaseClaim = await fetch(`${baseUrl}/leases/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer worker-test-token" },
      body: JSON.stringify({ callId, roomName: session.roomName, dispatchId: "provider-dispatch-id", participantId: workerParticipantIdentity(callId) })
    });
    expect(leaseClaim.status).toBe(200);
    const lease = await leaseClaim.json() as { token: string; agentEpoch: number };
    const sourceEvents = runtimeReplayCorpus.map((event) => WorkerEventSchema.parse(event));
    const occurredAt = new Date().toISOString();
    const events = sourceEvents.map((event) => ({
      ...event,
      callId,
      agentEpoch: lease.agentEpoch,
      occurredAt,
      payload: event.type === "agent.ready"
        ? { participantId: workerParticipantIdentity(callId) }
        : event.type === "transcript.final"
          ? { ...event.payload, participantId: "caller" }
          : event.payload
    }));
    for (const event of events) {
      const response = await fetch(`${baseUrl}/calls/${callId}/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${lease.token}` }, body: JSON.stringify(event) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ eventId: event.eventId, status: "committed" });
    }
    expect(await db.voiceEvent.count({ where: { sessionId: session.id } })).toBe(3);
    expect((await db.voiceSession.findUniqueOrThrow({ where: { id: session.id } })).finalWatermark).toBe(2);
  });

  it("answers credential, scope and schema failures with their documented statuses", async () => {
    const started = async () => {
      const callId = `voice-${randomUUID()}`;
      await db.call.create({ data: { id: callId, provider: "BROWSER", isTest: true, fromNumber: "browser" } });
      const session = await createVoiceSession({ requestId: `request-${callId}`, callId, callerParticipantId: "caller", language: "en" }, db);
      await recordVoiceDispatch(session.id, "provider-dispatch-id", db);
      return { callId, claim: { callId, roomName: session.roomName, dispatchId: "provider-dispatch-id", participantId: workerParticipantIdentity(callId) } };
    };
    const send = (method: string, path: string, authorization?: string, body?: unknown) => fetch(`${baseUrl}${path}`, { method, headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const call = await started();
    const other = await started();
    expect((await send("POST", "/leases/claim", undefined, call.claim)).status).toBe(401);
    expect((await send("POST", "/leases/claim", "Bearer wrong-token", call.claim)).status).toBe(401);
    const lease = await (await send("POST", "/leases/claim", "Bearer worker-test-token", call.claim)).json() as { token: string; agentEpoch: number };
    const otherLease = await (await send("POST", "/leases/claim", "Bearer worker-test-token", other.claim)).json() as { token: string };
    // The global worker credential, another call's lease and an unknown call all
    // look the same: a call's existence is not disclosed.
    expect((await send("GET", `/calls/${call.callId}/context`, "Bearer worker-test-token")).status).toBe(401);
    expect((await send("GET", `/calls/${call.callId}/context`, `Bearer ${otherLease.token}`)).status).toBe(401);
    expect((await send("GET", "/calls/voice-unknown/context", `Bearer ${lease.token}`)).status).toBe(401);
    expect((await send("GET", `/calls/${call.callId}/tools/anything`, "Bearer v1.1.forged")).status).toBe(401);
    expect((await send("GET", `/calls/${call.callId}/context`, `Bearer ${lease.token}`)).status).toBe(200);
    const overflow = { schemaVersion: 1, eventId: randomUUID(), callId: call.callId, agentEpoch: lease.agentEpoch, sourceSequence: 2_147_483_648, occurredAt: new Date().toISOString(), type: "agent.ready", payload: { participantId: workerParticipantIdentity(call.callId) } };
    expect((await send("POST", `/calls/${call.callId}/events`, `Bearer ${lease.token}`, overflow)).status).toBe(400);
    // Text PostgreSQL cannot store is refused at once rather than failing on every retry.
    for (const bad of [String.fromCharCode(0), String.fromCharCode(0xd800)]) {
      const unstorable = { ...overflow, eventId: randomUUID(), sourceSequence: 1, type: "transcript.final", payload: { segmentId: "segment", revision: 1, speaker: "CALLER", participantId: "caller", sequence: 1, text: `doodh${bad}`, language: "en" } };
      expect((await send("POST", `/calls/${call.callId}/events`, `Bearer ${lease.token}`, unstorable)).status).toBe(400);
    }
    const followUp = { journey: "CONSUMER_COMPLAINT", callerConfirmation: "FOLLOW_UP", parentRequestId: "missing-request", fields: { product: "Oil", purchaseArea: "Indore", issueCategory: "quality", description: "Leaking", productAvailable: true }, queue: { territory: "MP", language: "hi" } };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rejected = await send("POST", `/calls/${call.callId}/tools`, `Bearer ${lease.token}`, { invocationId: "follow-up", agentEpoch: lease.agentEpoch, name: "create_business_request", arguments: followUp });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toEqual({ error: "PARENT_NOT_ACCESSIBLE" });
    }
    process.env.VOICE_ENABLED = "false";
    try {
      expect((await send("POST", "/leases/claim", "Bearer worker-test-token", call.claim)).status).toBe(503);
    } finally {
      process.env.VOICE_ENABLED = "true";
    }
  });
});
