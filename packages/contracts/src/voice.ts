import { z } from "zod";

const id = z.string().min(1).max(128);
const text = z.string().min(1).max(4_000);
const occurredAt = z.string().datetime({ offset: true });
const positive = z.number().int().positive();

export const VoiceLeaseClaimSchema = z.strictObject({ callId: id, roomName: id, dispatchId: id, participantId: id });
export const VoiceLeaseSchema = z.strictObject({ callId: id, agentEpoch: positive, expiresAt: occurredAt, token: z.string().min(32).max(256) });
export const VoiceLeaseRenewSchema = z.strictObject({ agentEpoch: positive });
export const VoiceContextSchema = z.strictObject({
  callId: id, roomName: id, agentEpoch: positive, callerParticipantId: id, agentParticipantId: id,
  language: z.string().min(1).max(32), permittedTools: z.array(z.literal("create_business_request")).max(1), prompt: z.string().max(2_000)
});
const Envelope = { schemaVersion: z.literal(1), eventId: id, callId: id, agentEpoch: positive, sourceSequence: positive, occurredAt };
export const WorkerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...Envelope, type: z.literal("transcript.final"), payload: z.strictObject({ segmentId: id, revision: positive, speaker: z.enum(["CALLER", "AGENT", "HUMAN"]), participantId: id, sequence: positive, text, startMs: z.number().int().nonnegative().nullable().optional(), endMs: z.number().int().nonnegative().nullable().optional(), language: z.string().min(1).max(32) }) }),
  z.strictObject({ ...Envelope, type: z.literal("agent.ready"), payload: z.strictObject({ participantId: id }) }),
  z.strictObject({ ...Envelope, type: z.literal("agent.failed"), payload: z.strictObject({ code: z.enum(["CONFIGURATION", "TRANSIENT", "FATAL", "LEASE_LOST"]) }) }),
  z.strictObject({ ...Envelope, type: z.literal("control.ack"), payload: z.strictObject({ controlId: id, state: z.enum(["PAUSED", "STOPPED"]) }) }),
  z.strictObject({ ...Envelope, type: z.literal("transcript.flushed"), payload: z.strictObject({ lastSourceSequence: positive }) })
]);
export const VoiceEventReceiptSchema = z.strictObject({ eventId: id, status: z.enum(["committed", "duplicate"]) });
export const VoiceToolSchema = z.strictObject({ invocationId: id, agentEpoch: positive, name: z.literal("create_business_request"), arguments: z.unknown() });

export type VoiceLeaseClaim = z.infer<typeof VoiceLeaseClaimSchema>;
export type VoiceLease = z.infer<typeof VoiceLeaseSchema>;
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
export type VoiceTool = z.infer<typeof VoiceToolSchema>;
export const VoiceSchemas = { VoiceLeaseClaim: VoiceLeaseClaimSchema, VoiceLease: VoiceLeaseSchema, VoiceLeaseRenew: VoiceLeaseRenewSchema, VoiceContext: VoiceContextSchema, WorkerEvent: WorkerEventSchema, VoiceEventReceipt: VoiceEventReceiptSchema, VoiceTool: VoiceToolSchema } as const;
