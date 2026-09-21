import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { PrismaClient } from "@msva/db";
import { createVoiceSession, recordVoiceDispatch, workerParticipantIdentity } from "./voiceService.js";
import { voiceRouter } from "./voiceRoutes.js";
import { internalRouter } from "./routes/internal.js";

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
    const occurredAt = new Date().toISOString();
    const events = [
      { schemaVersion: 1, eventId: randomUUID(), callId, agentEpoch: lease.agentEpoch, sourceSequence: 1, occurredAt, type: "agent.ready", payload: { participantId: workerParticipantIdentity(callId) } },
      { schemaVersion: 1, eventId: randomUUID(), callId, agentEpoch: lease.agentEpoch, sourceSequence: 2, occurredAt, type: "transcript.final", payload: { segmentId: "caller-1", revision: 1, speaker: "CALLER", participantId: "caller", sequence: 1, text: "hello", language: "en", startMs: null, endMs: null } },
      { schemaVersion: 1, eventId: randomUUID(), callId, agentEpoch: lease.agentEpoch, sourceSequence: 3, occurredAt, type: "transcript.flushed", payload: { lastSourceSequence: 2 } }
    ];
    for (const event of events) {
      const response = await fetch(`${baseUrl}/calls/${callId}/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${lease.token}` }, body: JSON.stringify(event) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ eventId: event.eventId, status: "committed" });
    }
    expect(await db.voiceEvent.count({ where: { sessionId: session.id } })).toBe(3);
    expect((await db.voiceSession.findUniqueOrThrow({ where: { id: session.id } })).finalWatermark).toBe(2);
  });
});
