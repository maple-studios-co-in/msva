import { z } from "zod";

/**
 * Text PostgreSQL can store: no NUL and no unpaired UTF-16 surrogate. Anything
 * else would fail in the database on every retry, so it is refused here.
 */
export const WELL_FORMED_TEXT = /^(?:[^\u0000\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/;
const id = z.string().min(1).max(128).regex(WELL_FORMED_TEXT);
const text = z.string().min(1).max(4_000).regex(WELL_FORMED_TEXT);
const language = z.string().min(1).max(32).regex(WELL_FORMED_TEXT);
const occurredAt = z.string().datetime({ offset: true });
// Wire integers are stored in PostgreSQL INT4 columns.
const INT4_MAX = 2_147_483_647;
const positive = z.number().int().positive().max(INT4_MAX);
const offsetMs = z.number().int().nonnegative().max(INT4_MAX).nullable().optional();

export const VoiceLeaseClaimSchema = z.strictObject({ callId: id, roomName: id, dispatchId: id, participantId: id });
export const VoiceLeaseSchema = z.strictObject({ callId: id, agentEpoch: positive, expiresAt: occurredAt, token: z.string().min(32).max(256) });
export const VoiceLeaseRenewSchema = z.strictObject({ agentEpoch: positive });
export const VoiceContextSchema = z.strictObject({
  callId: id, roomName: id, agentEpoch: positive, callerParticipantId: id, agentParticipantId: id,
  language: z.string().min(1).max(32), permittedTools: z.array(z.literal("create_business_request")).max(1), prompt: z.string().max(2_000)
});
const Envelope = { schemaVersion: z.literal(1), eventId: id, callId: id, agentEpoch: positive, sourceSequence: positive, occurredAt };
export const WorkerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...Envelope, type: z.literal("transcript.final"), payload: z.strictObject({ segmentId: id, revision: positive, speaker: z.enum(["CALLER", "AGENT", "HUMAN"]), participantId: id, sequence: positive, text, startMs: offsetMs, endMs: offsetMs, language }) }),
  z.strictObject({ ...Envelope, type: z.literal("agent.ready"), payload: z.strictObject({ participantId: id }) }),
  z.strictObject({ ...Envelope, type: z.literal("agent.failed"), payload: z.strictObject({ code: z.enum(["CONFIGURATION", "TRANSIENT", "FATAL", "LEASE_LOST"]) }) }),
  z.strictObject({ ...Envelope, type: z.literal("control.ack"), payload: z.strictObject({ controlId: id, state: z.enum(["PAUSED", "STOPPED"]) }) }),
  z.strictObject({ ...Envelope, type: z.literal("transcript.flushed"), payload: z.strictObject({ lastSourceSequence: positive }) })
]);
export const VoiceEventReceiptSchema = z.strictObject({ eventId: id, status: z.enum(["committed", "duplicate"]) });
export const VoiceErrorSchema = z.strictObject({ error: z.string().min(1).max(64) });
export const VoiceToolSchema = z.strictObject({ invocationId: id, agentEpoch: positive, name: z.literal("create_business_request"), arguments: z.unknown() });

export type VoiceLeaseClaim = z.infer<typeof VoiceLeaseClaimSchema>;
export type VoiceLease = z.infer<typeof VoiceLeaseSchema>;
export type WorkerEvent = z.infer<typeof WorkerEventSchema>;
export type VoiceTool = z.infer<typeof VoiceToolSchema>;
export const VoiceSchemas = { VoiceLeaseClaim: VoiceLeaseClaimSchema, VoiceLease: VoiceLeaseSchema, VoiceLeaseRenew: VoiceLeaseRenewSchema, VoiceContext: VoiceContextSchema, WorkerEvent: WorkerEventSchema, VoiceEventReceipt: VoiceEventReceiptSchema, VoiceTool: VoiceToolSchema, VoiceError: VoiceErrorSchema } as const;
