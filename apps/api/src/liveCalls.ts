import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { Prisma, prisma } from "@msva/db";
import type { LiveCallRow, LiveCallsResponse } from "@msva/shared";
import { z } from "zod";

const positiveInteger = (max: number, fallback: number) => z.string().regex(/^[1-9]\d*$/)
  .transform(Number).pipe(z.number().int().min(1).max(max)).default(String(fallback));
const filtersSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  channel: z.enum(["all", "phone", "browser"]).default("all"),
  page: positiveInteger(10_000, 1),
  pageSize: positiveInteger(50, 25)
});

/** The demo's reporting day is India time, independently of the server's timezone. */
function startOfIndiaDay(now: Date): Date {
  const offsetMs = 330 * 60_000;
  const day = new Date(now.getTime() + offsetMs);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - offsetMs);
}

function maskedCaller(phone: string): string {
  // Values such as "browser-12345678" are not telephone numbers.
  if (!/^[+\d\s().-]+$/.test(phone)) return "Not provided";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8 || /0{8,}$/.test(digits)) return "Not provided";
  return `•••• ${digits.slice(-4)}`;
}

type RecordedRow = {
  id: string;
  provider: "BROWSER" | "EXOTEL" | "TWILIO";
  fromNumber: string;
  startedAt: Date;
  endedAt: Date | null;
  status: LiveCallRow["status"];
  durationMs: number | null;
  turns: number;
  tickets: number;
  fallbackTurns: number;
  recognitionRetries: number;
  isTest: boolean;
};

/** Construct every public property explicitly; never spread database records. */
function publicRow(row: RecordedRow): LiveCallRow {
  return {
    id: `call_${createHash("sha256").update(row.id).digest("hex").slice(0, 24)}`,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    channel: row.provider === "BROWSER" ? "browser" : "phone",
    // Browser profiles have canned phone numbers, not verified caller identity.
    caller: row.provider === "BROWSER" ? "Not provided" : maskedCaller(row.fromNumber),
    status: row.status,
    durationMs: row.durationMs,
    turns: row.turns,
    tickets: row.tickets,
    fallbackTurns: row.fallbackTurns,
    recognitionRetries: row.recognitionRetries,
    isTest: row.isTest
  };
}

export function createLiveCallsHandler(now: () => Date = () => new Date()): RequestHandler {
  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const at = now();
    const parsed = filtersSchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({ error: "Invalid call filters. Use an ISO timestamp, channel all/phone/browser, page 1–10000 and pageSize 1–50." });
      return;
    }
    const { channel, page, pageSize } = parsed.data;
    const from = parsed.data.from ? new Date(parsed.data.from) : startOfIndiaDay(at);
    if (!Number.isFinite(from.getTime()) || from > at) {
      response.status(400).json({ error: "The call start filter must be a valid timestamp that is not in the future." });
      return;
    }

    const provider = channel === "browser"
      ? Prisma.sql`c."provider" = ${"BROWSER"}::"CallProvider"`
      : channel === "phone"
        ? Prisma.sql`c."provider" IN (${"EXOTEL"}::"CallProvider", ${"TWILIO"}::"CallProvider")`
        : Prisma.sql`TRUE`;
    // Parameterized SQL keeps absent/null JSON metadata eligible. A negated
    // JSON-path filter can inadvertently exclude these ordinary real calls.
    const where = Prisma.sql`
      c."startedAt" >= ${from} AND c."startedAt" <= ${at}
      AND ${provider}
      AND LOWER(c."id") NOT LIKE ${"qa-%"}
      AND LOWER(COALESCE(c."source", '')) NOT IN (${"seed"}, ${"synthetic"})
      AND LOWER(COALESCE(c."metadata"->>'source', '')) NOT IN (${"seed"}, ${"synthetic"})
    `;

    try {
      // Both reads share a database snapshot, so live turn inserts cannot make
      // the summary disagree with the page. Summary counts cover the full filter.
      const { summary, rows } = await prisma.$transaction(async (tx) => {
        const [summary] = await tx.$queryRaw<LiveCallsResponse["summary"][]>(Prisma.sql`
          WITH filtered AS (SELECT c."id", c."status", c."endedAt" FROM "Call" c WHERE ${where})
          SELECT
            COUNT(*)::integer AS "totalCalls",
            COUNT(*) FILTER (WHERE "status" IN ('QUEUED', 'RINGING', 'IN_PROGRESS') AND "endedAt" IS NULL)::integer AS "activeCalls",
            COUNT(*) FILTER (WHERE "status" = 'COMPLETED')::integer AS "completedCalls",
            COUNT(*) FILTER (WHERE "status" IN ('FAILED', 'NO_ANSWER'))::integer AS "failedCalls",
            (SELECT COUNT(*)::integer FROM "Ticket" t JOIN filtered f ON f."id" = t."callId") AS "tickets",
            (SELECT COUNT(*)::integer FROM "Turn" t JOIN filtered f ON f."id" = t."callId" WHERE t."source" = 'fallback') AS "fallbackTurns",
            (SELECT COUNT(*)::integer FROM "Turn" t JOIN filtered f ON f."id" = t."callId" WHERE t."source" = 'asr_error') AS "recognitionRetries"
          FROM filtered
        `);
        const rows = await tx.$queryRaw<RecordedRow[]>(Prisma.sql`
          SELECT c."id", c."provider", c."fromNumber", c."startedAt", c."endedAt",
            c."status", c."durationMs", c."isTest",
            (SELECT COUNT(*)::integer FROM "Turn" t WHERE t."callId" = c."id") AS "turns",
            (SELECT COUNT(*)::integer FROM "Ticket" t WHERE t."callId" = c."id") AS "tickets",
            (SELECT COUNT(*)::integer FROM "Turn" t WHERE t."callId" = c."id" AND t."source" = 'fallback') AS "fallbackTurns",
            (SELECT COUNT(*)::integer FROM "Turn" t WHERE t."callId" = c."id" AND t."source" = 'asr_error') AS "recognitionRetries"
          FROM "Call" c WHERE ${where}
          ORDER BY c."startedAt" DESC, c."id" DESC
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
        `);
        if (!summary) throw new Error("Missing call aggregate");
        return { summary, rows };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

      const result: LiveCallsResponse = {
        source: "recorded_calls", updatedAt: at.toISOString(), from: from.toISOString(), channel,
        summary: {
          totalCalls: summary.totalCalls,
          activeCalls: summary.activeCalls,
          completedCalls: summary.completedCalls,
          failedCalls: summary.failedCalls,
          tickets: summary.tickets,
          fallbackTurns: summary.fallbackTurns,
          recognitionRetries: summary.recognitionRetries
        },
        items: rows.map(publicRow), page, pageSize, total: summary.totalCalls
      };
      response.json(result);
    } catch {
      response.status(503).json({ error: "Recorded calls are temporarily unavailable. Please try again." });
    }
  };
}
