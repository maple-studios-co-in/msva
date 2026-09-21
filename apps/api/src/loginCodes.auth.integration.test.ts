import { PrismaClient } from "@msva/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.MSVA_AUTH_TEST_DATABASE_URL;
if (!databaseUrl || !databaseUrl.includes("msva_auth_test")) throw new Error("MSVA_AUTH_TEST_DATABASE_URL must point to disposable msva_auth_test");
const db = new PrismaClient({ datasourceUrl: databaseUrl });

beforeEach(async () => {
  vi.resetModules();
  process.env.NODE_ENV = "development";
  process.env.AUTH_CODE_HASH_KEY = "auth-code-test-key";
  process.env.AUTH_RATE_HASH_KEY = "auth-rate-test-key";
  await db.authRateBucket.deleteMany();
  await db.loginCode.deleteMany();
  await db.session.deleteMany();
  await db.user.deleteMany();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => db.$disconnect());

async function authWithFakeDelivery(send: (input: { recipient: string; code: string; expiresAt: Date }) => Promise<void>) {
  const auth = await import("./auth.js");
  auth.setLoginCodeDeliveryForTest({ send });
  return auth;
}

describe("database-backed login codes", () => {
  it("delivers a hashed code and lets only one concurrent verification create a session", async () => {
    const user = await db.user.create({ data: { email: "agent@example.test", name: "Agent", role: "AGENT" } });
    let deliveredCode = "";
    const auth = await authWithFakeDelivery(async ({ code }) => { deliveredCode = code; });
    expect(await auth.requestLoginCode(user.email, { address: "203.0.113.10" })).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await db.loginCode.findFirstOrThrow()).deliveryState).toBe("DELIVERED"));
    const [first, second] = await Promise.all([
      auth.verifyLoginCode(user.email, deliveredCode, { address: "203.0.113.10" }),
      auth.verifyLoginCode(user.email, deliveredCode, { address: "203.0.113.10" })
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    expect((await db.loginCode.findFirstOrThrow()).usedAt).not.toBeNull();
  });

  it("does not activate a late superseded delivery", async () => {
    const user = await db.user.create({ data: { email: "late@example.test", name: "Late", role: "AGENT" } });
    let releaseFirst!: () => void;
    let sends = 0;
    const auth = await authWithFakeDelivery(async () => {
      sends += 1;
      if (sends === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    await auth.requestLoginCode(user.email, { address: "203.0.113.11" });
    await db.authRateBucket.deleteMany();
    await auth.requestLoginCode(user.email, { address: "203.0.113.12" });
    releaseFirst();
    await vi.waitFor(() => expect(sends).toBe(2));
    await vi.waitFor(async () => expect(await db.loginCode.count({ where: { deliveryState: "DELIVERED" } })).toBe(1));
    expect(await db.loginCode.count({ where: { deliveryState: "FAILED" } })).toBe(1);
  });

  it("persists request throttles for a normalized email", async () => {
    const auth = await authWithFakeDelivery(async () => undefined);
    expect(await auth.requestLoginCode("unknown@example.test", { address: "203.0.113.13" })).toEqual({ ok: true });
    const denied = await auth.requestLoginCode(" UNKNOWN@example.test ", { address: "203.0.113.14" });
    expect(denied).toMatchObject({ ok: false, limited: true });
    expect(await db.authRateBucket.count()).toBeGreaterThan(0);
  });

  it("rolls back code consumption when session creation fails", async () => {
    const user = await db.user.create({ data: { email: "rollback@example.test", name: "Rollback", role: "AGENT" } });
    let deliveredCode = "";
    const auth = await authWithFakeDelivery(async ({ code }) => { deliveredCode = code; });
    await auth.requestLoginCode(user.email, { address: "203.0.113.15" });
    await vi.waitFor(async () => expect((await db.loginCode.findFirstOrThrow()).deliveryState).toBe("DELIVERED"));
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_auth_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'auth test session failure'; END; $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER fail_auth_session_insert BEFORE INSERT ON "Session" FOR EACH ROW EXECUTE FUNCTION fail_auth_session_insert()`);
    try {
      await expect(auth.verifyLoginCode(user.email, deliveredCode, { address: "203.0.113.15" })).rejects.toThrow("auth test session failure");
      expect((await db.loginCode.findFirstOrThrow()).usedAt).toBeNull();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_auth_session_insert ON "Session"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS fail_auth_session_insert()`);
    }
  });
});
