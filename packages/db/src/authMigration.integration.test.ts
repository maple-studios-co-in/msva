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
const priorMigrations = ["20260905140843_init", "20260920202258_add_call_assessment", "20260921000000_demo_journeys", "20260921150000_add_assessment_jobs"].map(migration);
const authMigration = migration("20260921160000_add_auth_hardening");

// Columns that existed before the auth migration; the snapshot must not change.
const snapshotSql = `SELECT json_build_object(
  'users', (SELECT coalesce(json_agg(row_to_json(u) ORDER BY u.id), '[]'::json) FROM "User" u),
  'sessions', (SELECT coalesce(json_agg(row_to_json(s) ORDER BY s.id), '[]'::json) FROM "Session" s),
  'codes', (SELECT coalesce(json_agg(json_build_object('id', c.id, 'userId', c."userId", 'codeHash', c."codeHash", 'expiresAt', c."expiresAt", 'usedAt', c."usedAt", 'createdAt', c."createdAt") ORDER BY c.id), '[]'::json) FROM "LoginCode" c)
)::text`;

const schemas: string[] = [];

async function psqlRun(schema: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl!, ...args], {
    cwd: repoRoot.pathname,
    env: { ...process.env, PGOPTIONS: `-c search_path=${schema},public` }
  });
  return stdout;
}

const scalar = async (schema: string, sql: string) => (await psqlRun(schema, ["-t", "-A", "-c", sql])).trim();

afterEach(async () => {
  await Promise.all(
    schemas.splice(0).map((schema) =>
      execFileAsync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl!, "-c", `DROP SCHEMA IF EXISTS ${schema} CASCADE`])
    )
  );
});

describe("auth hardening migration", () => {
  it("keeps existing sessions and leaves codes issued before it unusable", async () => {
    const schema = `msva_auth_migration_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    await execFileAsync(psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", databaseUrl!, "-c", `CREATE SCHEMA ${schema}`]);
    for (const file of priorMigrations) await psqlRun(schema, ["-f", file.pathname]);
    await psqlRun(schema, [
      "-c",
      `INSERT INTO "User" ("id", "email", "name", "role", "lastLoginAt") VALUES ('user-auth', 'auth@example.test', 'Auth Admin', 'ADMIN', '2026-09-20T01:02:03.000Z'), ('user-off', 'off@example.test', 'Former', 'AGENT', NULL);
       UPDATE "User" SET "active" = false WHERE "id" = 'user-off';
       INSERT INTO "Session" ("id", "userId", "tokenHash", "expiresAt", "createdAt", "lastSeenAt") VALUES ('session-auth', 'user-auth', '${"b".repeat(64)}', '2099-01-01T00:00:00.000Z', '2026-09-20T01:02:03.000Z', '2026-09-20T01:03:03.000Z');
       INSERT INTO "LoginCode" ("id", "userId", "codeHash", "expiresAt", "usedAt", "createdAt") VALUES
         ('code-open', 'user-auth', '${"c".repeat(64)}', '2099-01-01T00:00:00.000Z', NULL, '2026-09-20T01:00:00.000Z'),
         ('code-used', 'user-auth', '${"d".repeat(64)}', '2026-09-20T01:10:00.000Z', '2026-09-20T01:01:00.000Z', '2026-09-20T01:00:30.000Z');`
    ]);
    const before = await scalar(schema, snapshotSql);

    await psqlRun(schema, ["-f", authMigration.pathname]);

    expect(await scalar(schema, snapshotSql)).toBe(before);
    // Old codes were never delivered through the tracked path, so verification
    // (which requires DELIVERED) cannot accept them, and they hold no capacity.
    expect(await scalar(schema, `SELECT string_agg("id" || ':' || "deliveryState" || ':' || "attempts" || ':' || coalesce("deliveryLeaseExpiresAt"::text, 'none'), ',' ORDER BY "id") FROM "LoginCode"`))
      .toBe("code-open:PENDING:0:none,code-used:PENDING:0:none");
    expect(await scalar(schema, `SELECT count(*) FROM "AuthRateBucket"`)).toBe("0");
  });
});
