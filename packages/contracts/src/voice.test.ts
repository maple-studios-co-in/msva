import { describe, expect, it } from "vitest";
import { WorkerEventSchema, VoiceLeaseClaimSchema } from "./voice.js";

describe("voice-v1 contracts", () => {
  it("rejects unknown worker event fields and invalid source sequence", () => {
    expect(WorkerEventSchema.safeParse({ schemaVersion: 1, eventId: "e", callId: "c", agentEpoch: 1, sourceSequence: 0, occurredAt: "2026-09-21T00:00:00Z", type: "agent.ready", payload: { participantId: "a" } }).success).toBe(false);
    expect(VoiceLeaseClaimSchema.safeParse({ callId: "c", roomName: "r", dispatchId: "d", participantId: "p", extra: true }).success).toBe(false);
  });
});
