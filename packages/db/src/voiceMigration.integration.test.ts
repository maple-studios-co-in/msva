import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const psql = process.env.PSQL_BIN ?? "psql";
const databaseUrl = process.env.MSVA_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("MSVA_TEST_DATABASE_URL is required for PostgreSQL integration tests.");
}
if (new URL(databaseUrl).searchParams.get("application_name") !== "msva-foundation-integration") {
  throw new Error("MSVA_TEST_DATABASE_URL must use application_name=msva-foundation-integration.");
}
const repoRoot = new URL("../../..", import.meta.url);
const migration = (name: string) => new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url);
const priorMigrations = ["20260905140843_init", "20260920202258_add_call_assessment", "20260921000000_demo_journeys"].map(migration);
const voiceMigration = migration("20260921120000_add_voice_session_contracts");
const laterMigrations = ["20260921150000_add_assessment_jobs"].map(migration);

// Every table a deployed release may already hold rows in. The snapshot keeps
// full rows, so a migration that rewrites a value or default is detected.
const preservedTables = ["Caller", "User", "Session", "LoginCode", "Call", "Turn", "Utterance", "Ticket", "TicketNote", "CallAssessment", "BusinessRequest"];
const snapshotSql = `SELECT json_build_object(${preservedTables
  .map((table) => `'${table}', (SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.id), '[]'::json) FROM "${table}" t)`)
  .join(", ")})::text`;

const schemas: string[] = [];

function schemaName(): string {
  return `msva_voice_migration_${randomUUID().replaceAll("-", "")}`;
}

async function psqlRun(schema: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl!, ...args], {
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
      execFileAsync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl!, "-c", `DROP SCHEMA IF EXISTS ${schema} CASCADE`])
    )
  );
});

describe("voice session migration", () => {
  it("preserves populated auth, call, Jev and demo records through later migrations", async () => {
    const schema = schemaName();
    schemas.push(schema);
    await execFileAsync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl!, "-c", `CREATE SCHEMA ${schema}`]);
    for (const file of priorMigrations) await applyFile(schema, file);

    await psqlRun(schema, [
      "-c",
      `INSERT INTO "Caller" ("id", "phone", "createdAt", "updatedAt") VALUES ('caller-voice', '+919999999997', '2026-09-01T01:02:03.000Z', '2026-09-01T01:02:04.000Z');
       INSERT INTO "User" ("id", "email", "name", "role", "lastLoginAt") VALUES ('user-voice', 'voice@example.test', 'Voice Reviewer', 'SUPERVISOR', '2026-09-02T01:02:03.000Z');
       INSERT INTO "Session" ("id", "userId", "tokenHash", "expiresAt") VALUES ('session-voice', 'user-voice', 'session-hash', '2099-01-01T00:00:00.000Z');
       INSERT INTO "LoginCode" ("id", "userId", "codeHash", "expiresAt") VALUES ('login-voice', 'user-voice', 'code-hash', '2026-09-02T01:12:03.000Z');
       INSERT INTO "Call" ("id", "provider", "status", "outcome", "fromNumber", "callerId", "startedAt", "endedAt") VALUES ('call-voice', 'EXOTEL', 'COMPLETED', 'TICKET_CREATED', '+919999999997', 'caller-voice', '2026-09-03T01:02:03.000Z', '2026-09-03T01:05:03.000Z');
       INSERT INTO "Turn" ("id", "callId", "index", "callerText", "replyText") VALUES ('turn-voice', 'call-voice', 0, 'doodh kharab tha', 'Main complaint darj kar raha hoon');
       INSERT INTO "Utterance" ("id", "callId", "seq", "speaker", "text", "atMs") VALUES ('utterance-caller', 'call-voice', 0, 'CALLER', 'doodh kharab tha', 1200), ('utterance-agent', 'call-voice', 1, 'AGENT', 'Main complaint darj kar raha hoon', 2400);
       INSERT INTO "Ticket" ("id", "number", "callId", "callerId", "phone", "intent", "summary", "updatedAt") VALUES ('ticket-voice', 7001, 'call-voice', 'caller-voice', '+919999999997', 'complaint', 'spoiled milk', '2026-09-03T01:06:03.000Z');
       INSERT INTO "TicketNote" ("id", "ticketId", "text") VALUES ('note-voice', 'ticket-voice', 'called back');
       INSERT INTO "CallAssessment" ("id", "callId", "inputHash", "requestedModel", "rubricVersion", "preprocessingVersion", "status", "requestedById", "attemptToken", "inputCharCount", "utteranceCount", "updatedAt") VALUES ('assessment-voice', 'call-voice', 'hash-voice', 'model-voice', 'rubric-v1', 'preprocess-v1', 'SUCCEEDED', 'user-voice', 'attempt-voice', 50, 2, CURRENT_TIMESTAMP);
       INSERT INTO "BusinessRequest" ("id", "requestId", "callId", "callerId", "ticketId", "journey", "callerConfirmation", "language", "territory", "fields", "payloadCanonical", "payloadHash", "result", "updatedAt") VALUES ('business-voice', 'request-voice', 'call-voice', 'caller-voice', 'ticket-voice', 'CONSUMER_COMPLAINT', 'NEW', 'hi', 'north', '{"product":"milk"}', '{}', '${"a".repeat(64)}', '{"ticketNumber":7001}', CURRENT_TIMESTAMP);`
    ]);
    const before = await scalar(schema, snapshotSql);

    await applyFile(schema, voiceMigration);
    expect(await scalar(schema, snapshotSql)).toBe(before);
    expect(await scalar(schema, `SELECT enum_range(NULL::"Speaker")::text`)).toBe("{CALLER,AGENT,HUMAN}");
    expect(await scalar(schema, `SELECT count(*) FROM "VoiceSession"`)).toBe("0");

    // The new tables and speaker accept records for calls that predate them, and
    // a voice session keeps its call from being deleted underneath it.
    await psqlRun(schema, [
      "-c",
      `INSERT INTO "Utterance" ("id", "callId", "seq", "speaker", "text") VALUES ('utterance-human', 'call-voice', 2, 'HUMAN', 'Main supervisor hoon');
       INSERT INTO "Call" ("id", "provider", "fromNumber") VALUES ('call-livekit', 'BROWSER', 'browser');
       INSERT INTO "VoiceSession" ("id", "callId", "roomName", "createRequestId", "createRequestHash", "dispatchIntentId") VALUES ('voice-session', 'call-livekit', 'msva-room', 'create-voice', 'create-hash', 'dispatch-voice');`
    ]);
    await expect(psqlRun(schema, ["-c", `DELETE FROM "Call" WHERE "id" = 'call-livekit'`])).rejects.toThrow(/VoiceSession_callId_fkey/);
    await psqlRun(schema, [
      "-c",
      `DELETE FROM "Utterance" WHERE "id" = 'utterance-human'; DELETE FROM "VoiceSession" WHERE "id" = 'voice-session'; DELETE FROM "Call" WHERE "id" = 'call-livekit';`
    ]);

    for (const file of laterMigrations) await applyFile(schema, file);
    expect(await scalar(schema, snapshotSql)).toBe(before);
  });
});
