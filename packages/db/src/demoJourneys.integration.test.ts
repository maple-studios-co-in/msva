import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const psql = "/opt/homebrew/opt/postgresql@17/bin/psql";
const databaseUrl =
  process.env.MSVA_TEST_DATABASE_URL ??
  "postgresql://adityaagrawal@127.0.0.1:59421/msva_foundation_test";
const repoRoot = new URL("../../..", import.meta.url);
const initMigration = new URL("../prisma/migrations/20260905140843_init/migration.sql", import.meta.url);
const demoMigration = new URL("../prisma/migrations/20260921000000_demo_journeys/migration.sql", import.meta.url);

const schemas: string[] = [];

function schemaName(): string {
  return `msva_foundation_migration_${randomUUID().replaceAll("-", "")}`;
}

async function psqlRun(schema: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl, ...args], {
    cwd: repoRoot.pathname,
    env: { ...process.env, PGOPTIONS: `-c search_path=${schema},public` }
  });
  return stdout;
}

async function applyFile(schema: string, file: URL): Promise<void> {
  await psqlRun(schema, ["-f", file.pathname]);
}

async function scalar(schema: string, sql: string): Promise<string> {
  return (await psqlRun(schema, ["-t", "-A", "-c", sql])).trim();
}

afterEach(async () => {
  await Promise.all(
    schemas.splice(0).map((schema) =>
      execFileAsync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl, "-c", `DROP SCHEMA IF EXISTS ${schema} CASCADE`])
    )
  );
});

describe("demo journeys migration", () => {
  it("preserves representative legacy rows, timestamps, outcomes, and ticket sequence", async () => {
    const schema = schemaName();
    schemas.push(schema);
    await execFileAsync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl, "-c", `CREATE SCHEMA ${schema}`]);

    await applyFile(schema, initMigration);
    await psqlRun(schema, [
      "-c",
      `INSERT INTO "Caller" ("id", "phone", "createdAt", "updatedAt") VALUES ('caller-legacy', '+919999999999', '2022-04-03T01:02:03.000Z', '2022-04-03T01:02:04.000Z');
       INSERT INTO "Call" ("id", "provider", "fromNumber", "callerId", "outcome", "startedAt") VALUES ('call-legacy', 'BROWSER', '+919999999999', 'caller-legacy', 'ABANDONED', '2022-04-04T01:02:03.000Z');
       INSERT INTO "Ticket" ("id", "number", "callId", "callerId", "phone", "intent", "summary", "createdAt", "updatedAt") VALUES ('ticket-legacy', 4242, 'call-legacy', 'caller-legacy', '+919999999999', 'legacy', 'legacy summary', '2022-04-05T01:02:03.000Z', '2022-04-05T01:02:04.000Z');
       INSERT INTO "TicketNote" ("id", "ticketId", "text", "createdAt") VALUES ('note-legacy', 'ticket-legacy', 'legacy note', '2022-04-06T01:02:03.000Z');
       SELECT setval(pg_get_serial_sequence('"Ticket"', 'number'), 4242, true);`
    ]);

    const before = await scalar(
      schema,
      `SELECT row_to_json(snapshot)::text FROM (
         SELECT (SELECT row_to_json(c) FROM "Call" c WHERE c.id = 'call-legacy') AS call,
                (SELECT row_to_json(t) FROM (SELECT id, number, "callId", "callerId", phone, "callerName", intent, priority, status, summary, details, "assigneeId", "slaDueAt", "callbackStart", "callbackEnd", "resolutionCode", "externalRef", "createdAt", "updatedAt", "resolvedAt" FROM "Ticket" WHERE id = 'ticket-legacy') t) AS ticket,
                (SELECT row_to_json(n) FROM "TicketNote" n WHERE n.id = 'note-legacy') AS note,
                (SELECT count(*) FROM "Caller") AS callers,
                (SELECT count(*) FROM "Call") AS calls,
                (SELECT count(*) FROM "Ticket") AS tickets,
                (SELECT count(*) FROM "TicketNote") AS notes
       ) snapshot;`
    );

    await expect(readFile(demoMigration, "utf8")).resolves.toContain('CREATE TABLE "BusinessRequest"');
    await applyFile(schema, demoMigration);

    const after = await scalar(
      schema,
      `SELECT row_to_json(snapshot)::text FROM (
         SELECT (SELECT row_to_json(c) FROM "Call" c WHERE c.id = 'call-legacy') AS call,
                (SELECT row_to_json(t) FROM (SELECT id, number, "callId", "callerId", phone, "callerName", intent, priority, status, summary, details, "assigneeId", "slaDueAt", "callbackStart", "callbackEnd", "resolutionCode", "externalRef", "createdAt", "updatedAt", "resolvedAt" FROM "Ticket" WHERE id = 'ticket-legacy') t) AS ticket,
                (SELECT row_to_json(n) FROM "TicketNote" n WHERE n.id = 'note-legacy') AS note,
                (SELECT count(*) FROM "Caller") AS callers,
                (SELECT count(*) FROM "Call") AS calls,
                (SELECT count(*) FROM "Ticket") AS tickets,
                (SELECT count(*) FROM "TicketNote") AS notes
       ) snapshot;`
    );
    expect(after).toBe(before);

    await psqlRun(schema, [
      "-c",
      `INSERT INTO "Ticket" ("id", "phone", "intent", "summary", "updatedAt") VALUES ('ticket-new', '+910000000000', 'new', 'new summary', CURRENT_TIMESTAMP);`
    ]);
    expect(await scalar(schema, `SELECT "number"::text FROM "Ticket" WHERE id = 'ticket-new'`)).toBe("4243");
    expect(await scalar(schema, `SELECT "evidenceState"::text FROM "Ticket" WHERE id = 'ticket-legacy'`)).toBe("NOT_REQUESTED");
  });
});
