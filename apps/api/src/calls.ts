import {
  prisma,
  type CallOutcome,
  type CallProvider,
  type CallStatus,
  type CallerType,
  type Prisma
} from "@msva/db";

// ---------------------------------------------------------------------------
// Call persistence
//
// The telephony service (browser transport and Exotel transport alike) reports
// three lifecycle events per call — start, turn, end — through the internal
// routes. This module turns them into rows. Tools (create_ticket) link to the
// same Call row by the session id the telephony service minted.
// ---------------------------------------------------------------------------

export const digits = (value: string | undefined | null): string => (value ?? "").replace(/[^0-9]/g, "");

export function toCallerType(value: string | undefined | null): CallerType {
  switch ((value ?? "").toLowerCase()) {
    case "distributor":
      return "DISTRIBUTOR";
    case "retailer":
      return "RETAILER";
    case "customer":
    case "consumer":
      return "CUSTOMER";
    case "farmer":
      return "FARMER";
    default:
      return "UNKNOWN";
  }
}

export function toOutcome(value: string | undefined | null): CallOutcome | undefined {
  switch ((value ?? "").toLowerCase()) {
    case "resolved_by_va":
      return "RESOLVED_BY_VA";
    case "ticket_created":
      return "TICKET_CREATED";
    case "human_transfer":
      return "HUMAN_TRANSFER";
    case "in_progress":
      return "IN_PROGRESS";
    case "abandoned":
      return "ABANDONED";
    default:
      return undefined;
  }
}

function toProvider(value: string): CallProvider {
  switch (value.toLowerCase()) {
    case "exotel":
      return "EXOTEL";
    case "twilio":
      return "TWILIO";
    default:
      return "BROWSER";
  }
}

/** Find-or-create the caller for a phone number. Returns null for numbers we cannot key on. */
export async function ensureCaller(
  phone: string | undefined | null,
  hints: { name?: string | null; type?: CallerType } = {}
): Promise<{ id: string } | null> {
  const key = digits(phone);
  if (key.length < 8) return null;
  const existing = await prisma.caller.findUnique({ where: { phone: key } });
  if (existing) {
    // Fill in what we did not know before; never overwrite a curated record.
    const data: Prisma.CallerUpdateInput = {};
    if (!existing.name && hints.name) data.name = hints.name;
    if (existing.type === "UNKNOWN" && hints.type && hints.type !== "UNKNOWN") data.type = hints.type;
    if (Object.keys(data).length > 0) await prisma.caller.update({ where: { id: existing.id }, data });
    return { id: existing.id };
  }
  const created = await prisma.caller.create({
    data: { phone: key, name: hints.name ?? undefined, type: hints.type ?? "UNKNOWN" }
  });
  return { id: created.id };
}

export type CallStartInput = {
  id: string;
  provider: string;
  providerSid?: string | null;
  fromNumber: string;
  toNumber?: string | null;
  callerName?: string | null;
  callerType?: string | null;
  isTest?: boolean;
  agentSlug?: string | null;
  language?: string | null;
  metadata?: Record<string, unknown> | null;
};

export async function recordCallStart(input: CallStartInput): Promise<{ id: string }> {
  const callerType = toCallerType(input.callerType);
  const [caller, agent] = await Promise.all([
    ensureCaller(input.fromNumber, { name: input.callerName, type: callerType }),
    input.agentSlug
      ? prisma.agent.findUnique({ where: { slug: input.agentSlug } })
      : prisma.agent.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } })
  ]);

  const data = {
    provider: toProvider(input.provider),
    providerSid: input.providerSid ?? undefined,
    fromNumber: input.fromNumber,
    toNumber: input.toNumber ?? undefined,
    callerName: input.callerName ?? undefined,
    callerType,
    isTest: input.isTest ?? false,
    language: input.language ?? undefined,
    metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    callerId: caller?.id,
    agentId: agent?.id
  };

  const call = await prisma.call.upsert({
    where: { id: input.id },
    create: { id: input.id, ...data },
    update: data
  });
  return { id: call.id };
}

export type TurnInput = {
  index: number;
  callerText?: string | null;
  replyText?: string | null;
  asrMs?: number | null;
  llmFirstTokenMs?: number | null;
  llmTotalMs?: number | null;
  ttsFirstByteMs?: number | null;
  ttfwMs?: number | null;
  interrupted?: boolean;
  source?: string | null;
  toolCalls?: unknown;
  outcome?: string | null;
  collected?: Record<string, string> | null;
  escalationReason?: string | null;
  intent?: string | null;
};

export async function recordTurn(callId: string, turn: TurnInput): Promise<void> {
  const call = await prisma.call.findUnique({ where: { id: callId }, select: { id: true, startedAt: true } });
  if (!call) throw new Error(`Unknown call ${callId}`);
  const atMs = Date.now() - call.startedAt.getTime();

  const utterances: Prisma.UtteranceCreateManyInput[] = [];
  const seqBase = turn.index * 2;
  const callerText = (turn.callerText ?? "").trim();
  if (callerText && !callerText.startsWith("[")) {
    utterances.push({ callId, seq: seqBase, speaker: "CALLER", text: callerText, atMs });
  }
  const replyText = (turn.replyText ?? "").trim();
  if (replyText) {
    utterances.push({ callId, seq: seqBase + 1, speaker: "AGENT", text: replyText, atMs });
  }

  const turnData = {
    callerText: callerText || undefined,
    replyText: replyText || undefined,
    asrMs: turn.asrMs ?? undefined,
    llmFirstTokenMs: turn.llmFirstTokenMs ?? undefined,
    llmTotalMs: turn.llmTotalMs ?? undefined,
    ttsFirstByteMs: turn.ttsFirstByteMs ?? undefined,
    ttfwMs: turn.ttfwMs ?? undefined,
    interrupted: turn.interrupted ?? false,
    source: turn.source ?? undefined,
    toolCalls: (turn.toolCalls ?? undefined) as Prisma.InputJsonValue | undefined
  };

  const outcome = toOutcome(turn.outcome);
  const callUpdate: Prisma.CallUpdateInput = {};
  if (outcome && outcome !== "IN_PROGRESS") callUpdate.outcome = outcome;
  if (turn.collected && Object.keys(turn.collected).length > 0) callUpdate.collected = turn.collected;
  if (turn.escalationReason) callUpdate.escalationReason = turn.escalationReason;
  if (turn.intent && turn.intent !== "unknown") callUpdate.intent = turn.intent;

  await prisma.$transaction([
    prisma.turn.upsert({
      where: { callId_index: { callId, index: turn.index } },
      create: { callId, index: turn.index, ...turnData },
      update: turnData
    }),
    ...(utterances.length > 0
      ? [
          prisma.utterance.deleteMany({ where: { callId, seq: { in: utterances.map((u) => u.seq) } } }),
          prisma.utterance.createMany({ data: utterances })
        ]
      : []),
    ...(Object.keys(callUpdate).length > 0 ? [prisma.call.update({ where: { id: callId }, data: callUpdate })] : [])
  ]);
}

export async function recordCallEnd(
  callId: string,
  input: { status?: string | null; outcome?: string | null }
): Promise<void> {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { id: true, startedAt: true, outcome: true, endedAt: true, _count: { select: { turns: true, tickets: true } } }
  });
  if (!call) throw new Error(`Unknown call ${callId}`);
  if (call.endedAt) return; // idempotent

  const endedAt = new Date();
  let status: CallStatus = "COMPLETED";
  const requested = (input.status ?? "").toUpperCase();
  if (requested === "FAILED" || requested === "NO_ANSWER") status = requested;

  let outcome = toOutcome(input.outcome) ?? call.outcome;
  if (outcome === "IN_PROGRESS") {
    if (call._count.tickets > 0) outcome = "TICKET_CREATED";
    else outcome = call._count.turns > 1 ? "RESOLVED_BY_VA" : "ABANDONED";
  }

  await prisma.call.update({
    where: { id: callId },
    data: { status, outcome, endedAt, durationMs: endedAt.getTime() - call.startedAt.getTime() }
  });
}
