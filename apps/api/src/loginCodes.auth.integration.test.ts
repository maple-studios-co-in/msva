import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@msva/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.MSVA_AUTH_TEST_DATABASE_URL;
if (!databaseUrl || !databaseUrl.includes("msva_auth_test")) throw new Error("MSVA_AUTH_TEST_DATABASE_URL must point to disposable msva_auth_test");
const db = new PrismaClient({ datasourceUrl: databaseUrl });

type Send = (input: { recipient: string; code: string; expiresAt: Date }) => Promise<void>;
const network = (n: number) => ({ address: `203.0.113.${n}` });
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(async () => {
  vi.resetModules();
  process.env.NODE_ENV = "development";
  process.env.AUTH_CODE_HASH_KEY = "auth-code-test-key";
  process.env.AUTH_RATE_HASH_KEY = "auth-rate-test-key";
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  await db.authRateBucket.deleteMany();
  await db.loginCode.deleteMany();
  await db.session.deleteMany();
  await db.user.deleteMany();
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
});
afterAll(async () => db.$disconnect());

async function authWithFakeDelivery(send: Send) {
  const auth = await import("./auth.js");
  auth.setLoginCodeDeliveryForTest({ send });
  return auth;
}

/** A user whose freshly requested code has been delivered and is usable. */
async function deliveredLogin(email: string) {
  const user = await db.user.create({ data: { email, name: "Agent", role: "AGENT" } });
  let code = "";
  const auth = await authWithFakeDelivery(async (input) => { code = input.code; });
  await auth.requestLoginCode(email, network(1));
  await vi.waitFor(async () => expect((await db.loginCode.findFirstOrThrow({ where: { userId: user.id } })).deliveryState).toBe("DELIVERED"));
  await db.authRateBucket.deleteMany();
  return { user, auth, code };
}

/** Resolves once another database session is blocked waiting for a row lock. */
async function lockWaiterPresent() {
  await vi.waitFor(async () => {
    const [row] = await db.$queryRaw<{ waiting: bigint }[]>`SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    expect(Number(row!.waiting)).toBeGreaterThan(0);
  }, { timeout: 5_000, interval: 20 });
}

/** Makes LoginCode updates to `state` fail, as a database fault would. */
async function withFailingLoginCodeUpdate(state: "FAILED" | "DELIVERED", work: () => Promise<void>) {
  await db.$executeRawUnsafe(`CREATE FUNCTION fail_login_code_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."deliveryState" = '${state}' THEN RAISE EXCEPTION 'auth test update failure'; END IF; RETURN NEW; END; $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER fail_login_code_update BEFORE UPDATE ON "LoginCode" FOR EACH ROW EXECUTE FUNCTION fail_login_code_update()`);
  try {
    await work();
  } finally {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_login_code_update ON "LoginCode"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS fail_login_code_update()`);
  }
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

describe("login code delivery", () => {
  it("delivers a hashed code and lets only one concurrent verification create a session", async () => {
    const { user, auth, code } = await deliveredLogin("agent@example.test");
    const [first, second] = await Promise.all([
      auth.verifyLoginCode(user.email, code, network(10)),
      auth.verifyLoginCode(user.email, code, network(10))
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    const stored = await db.loginCode.findFirstOrThrow();
    expect(stored.usedAt).not.toBeNull();
    expect(stored.codeHash).not.toContain(code);
  });

  it("keeps the newest code usable when a superseded delivery completes last", async () => {
    const user = await db.user.create({ data: { email: "late@example.test", name: "Late", role: "AGENT" } });
    const codes: string[] = [];
    let releaseFirst!: () => void;
    const auth = await authWithFakeDelivery(async ({ code }) => {
      codes.push(code);
      if (codes.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    await auth.requestLoginCode(user.email, network(11));
    await db.authRateBucket.deleteMany();
    await auth.requestLoginCode(user.email, network(12));
    await vi.waitFor(async () => expect(await db.loginCode.count({ where: { deliveryState: "DELIVERED" } })).toBe(1));
    releaseFirst();
    await settle();
    expect(await db.loginCode.count({ where: { deliveryState: "DELIVERED" } })).toBe(1);
    expect(await auth.verifyLoginCode(user.email, codes[0]!, network(13))).toBeNull();
    expect(await auth.verifyLoginCode(user.email, codes[1]!, network(13))).toMatchObject({ user: { id: user.id } });
  });

  it("keeps the last delivered code usable when a newer send fails", async () => {
    const { user, code } = await deliveredLogin("retry@example.test");
    const auth = await authWithFakeDelivery(async () => { throw new Error("smtp down"); });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await auth.requestLoginCode(user.email, network(14));
    await vi.waitFor(async () => expect(await db.loginCode.count({ where: { deliveryState: "FAILED" } })).toBe(1));
    expect(await auth.verifyLoginCode(user.email, code, network(14))).toMatchObject({ user: { id: user.id } });
  });

  it("sends at most two codes at once across concurrent requests", async () => {
    const emails = Array.from({ length: 6 }, (_, index) => `cap${index}@example.test`);
    for (const email of emails) await db.user.create({ data: { email, name: email, role: "AGENT" } });
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const auth = await authWithFakeDelivery(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
    });
    const results = await Promise.all(emails.map((email, index) => auth.requestLoginCode(email, network(20 + index))));
    expect(results).toEqual(emails.map(() => ({ ok: true })));
    await settle(100);
    expect(maxInFlight).toBe(2);
    expect(await db.loginCode.count()).toBe(2);
    release();
    await vi.waitFor(async () => expect(await db.loginCode.count({ where: { deliveryState: "DELIVERED" } })).toBe(2));
  });

  it("reclaims abandoned pending deliveries without making them usable", async () => {
    const crashed = await db.user.create({ data: { email: "crashed@example.test", name: "Crashed", role: "AGENT" } });
    const abandoned = { userId: crashed.id, codeHash: "0".repeat(64), expiresAt: new Date(Date.now() + 600_000), deliveryLeaseExpiresAt: new Date(Date.now() - 1_000) };
    await db.loginCode.createMany({ data: [{ id: randomBytes(24).toString("hex"), ...abandoned }, { id: randomBytes(24).toString("hex"), ...abandoned }] });
    const { user } = await deliveredLogin("after-crash@example.test");
    expect(await db.loginCode.count({ where: { userId: crashed.id, deliveryState: "FAILED" } })).toBe(2);
    expect(await db.loginCode.count({ where: { userId: user.id, deliveryState: "DELIVERED" } })).toBe(1);
  });

  it("does not reject unhandled when delivery and its cleanup both fail", async () => {
    const user = await db.user.create({ data: { email: "outage@example.test", name: "Outage", role: "AGENT" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let code = "";
    const auth = await authWithFakeDelivery(async (input) => { code = input.code; throw new Error(`smtp rejected ${input.recipient}`); });
    await withFailingLoginCodeUpdate("FAILED", async () => {
      expect(await auth.requestLoginCode(user.email, network(30))).toEqual({ ok: true });
      await settle(500);
    });
    expect(unhandled).toEqual([]);
    // One fixed diagnostic: no address, code or provider detail.
    expect(warn.mock.calls).toEqual([["[auth] login code delivery failed"]]);
    expect((await db.loginCode.findFirstOrThrow()).deliveryState).toBe("PENDING");
    expect(await auth.verifyLoginCode(user.email, code, network(30))).toBeNull();
  });

  it("leaves a code unusable when activation fails after the send", async () => {
    const user = await db.user.create({ data: { email: "activation@example.test", name: "Activation", role: "AGENT" } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let code = "";
    const auth = await authWithFakeDelivery(async (input) => { code = input.code; });
    await withFailingLoginCodeUpdate("DELIVERED", async () => {
      await auth.requestLoginCode(user.email, network(31));
      await vi.waitFor(async () => expect((await db.loginCode.findFirstOrThrow()).deliveryState).toBe("FAILED"));
    });
    expect(unhandled).toEqual([]);
    expect(await auth.verifyLoginCode(user.email, code, network(31))).toBeNull();
  });
});

describe("login code verification", () => {
  it("rolls back code consumption when session creation fails", async () => {
    const { user, auth, code } = await deliveredLogin("rollback@example.test");
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_auth_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'auth test session failure'; END; $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER fail_auth_session_insert BEFORE INSERT ON "Session" FOR EACH ROW EXECUTE FUNCTION fail_auth_session_insert()`);
    try {
      await expect(auth.verifyLoginCode(user.email, code, network(40))).rejects.toThrow("auth test session failure");
      expect((await db.loginCode.findFirstOrThrow()).usedAt).toBeNull();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_auth_session_insert ON "Session"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS fail_auth_session_insert()`);
    }
  });

  it("rechecks the user after waiting for its row lock", async () => {
    const { user, auth, code } = await deliveredLogin("disabled@example.test");
    let verifying!: ReturnType<typeof auth.verifyLoginCode>;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
      verifying = auth.verifyLoginCode(user.email, code, network(41));
      await lockWaiterPresent();
      await tx.user.update({ where: { id: user.id }, data: { active: false } });
    }, { timeout: 15_000 });
    expect(await verifying).toBeNull();
    expect(await db.session.count()).toBe(0);
  });

  it("rechecks the attempt count after waiting for the code lock", async () => {
    const { user, auth, code } = await deliveredLogin("exhausted@example.test");
    let verifying!: ReturnType<typeof auth.verifyLoginCode>;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "LoginCode" WHERE "userId" = ${user.id} FOR UPDATE`;
      verifying = auth.verifyLoginCode(user.email, code, network(42));
      await lockWaiterPresent();
      await tx.loginCode.updateMany({ where: { userId: user.id }, data: { attempts: 5 } });
    }, { timeout: 15_000 });
    expect(await verifying).toBeNull();
    expect(await db.session.count()).toBe(0);
  });

  it("judges expiry by the time after its locks are held", async () => {
    const { user, auth, code } = await deliveredLogin("expiry@example.test");
    const expiresAt = new Date(Date.now() + 300);
    await db.loginCode.updateMany({ where: { userId: user.id }, data: { expiresAt } });
    let verifying!: ReturnType<typeof auth.verifyLoginCode>;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
      verifying = auth.verifyLoginCode(user.email, code, network(43));
      await lockWaiterPresent();
      await settle(Math.max(0, expiresAt.getTime() - Date.now()) + 200);
    }, { timeout: 15_000 });
    expect(await verifying).toBeNull();
    expect(await db.session.count()).toBe(0);
  });

  it("commits each wrong attempt and refuses the right code after five", async () => {
    const { user, auth, code } = await deliveredLogin("guess@example.test");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await auth.verifyLoginCode(user.email, wrongCode(code), network(44))).toBeNull();
      expect((await db.loginCode.findFirstOrThrow({ where: { userId: user.id } })).attempts).toBe(attempt);
    }
    expect(await auth.verifyLoginCode(user.email, code, network(44))).toBeNull();
    expect(await db.session.count()).toBe(0);
  });

  it("never accepts a code stored before delivery tracking existed", async () => {
    const user = await db.user.create({ data: { email: "legacy@example.test", name: "Legacy", role: "AGENT" } });
    const legacyHash = createHash("sha256").update("123456").digest("hex");
    // The migration defaults existing rows to PENDING with no lease.
    await db.loginCode.create({ data: { id: "legacy-code", userId: user.id, codeHash: legacyHash, expiresAt: new Date(Date.now() + 600_000) } });
    const auth = await authWithFakeDelivery(async () => undefined);
    expect(await auth.verifyLoginCode(user.email, "123456", network(45))).toBeNull();
    await db.loginCode.update({ where: { id: "legacy-code" }, data: { deliveryState: "DELIVERED" } });
    expect(await auth.verifyLoginCode(user.email, "123456", network(45))).toBeNull();
  });

  it("fails closed without the hash keys", async () => {
    const { user, auth, code } = await deliveredLogin("keys@example.test");
    delete process.env.AUTH_RATE_HASH_KEY;
    expect(await auth.verifyLoginCode(user.email, code, network(46))).toBeNull();
    expect(await db.authRateBucket.count()).toBe(0);
    expect(await db.session.count()).toBe(0);
  });
});

describe("shared throttles", () => {
  it("persists request throttles for a normalized email", async () => {
    const auth = await authWithFakeDelivery(async () => undefined);
    expect(await auth.requestLoginCode("unknown@example.test", network(50))).toEqual({ ok: true });
    const denied = await auth.requestLoginCode(" UNKNOWN@example.test ", network(51));
    expect(denied).toMatchObject({ ok: false, limited: true });
    expect(await db.authRateBucket.count()).toBeGreaterThan(0);
  });

  it("admits one concurrent request per email per minute", async () => {
    const auth = await authWithFakeDelivery(async () => undefined);
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => auth.requestLoginCode("race@example.test", network(52 + index))));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && "limited" in result)).toHaveLength(4);
  });

  it("limits unknown addresses with the global hourly bucket", async () => {
    const auth = await authWithFakeDelivery(async () => undefined);
    for (let index = 1; index <= 100; index += 1) {
      expect(await auth.requestLoginCode(`nobody${index}@example.test`, { address: `198.51.100.${index}` })).toEqual({ ok: true });
    }
    expect(await auth.requestLoginCode("nobody101@example.test", { address: "198.51.100.101" })).toMatchObject({ ok: false, limited: true });
    expect(await db.loginCode.count()).toBe(0);
  });

  it("rate-limits verification with a retry time", async () => {
    const auth = await authWithFakeDelivery(async () => undefined);
    for (let index = 0; index < 10; index += 1) expect(await auth.verifyLoginCode("probe@example.test", "123456", network(60))).toBeNull();
    const limited = await auth.verifyLoginCode("probe@example.test", "123456", network(60));
    expect(limited).toMatchObject({ limited: true });
    expect((limited as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
  });

  it("removes expired buckets in bounded batches", async () => {
    const expired = new Date(Date.now() - 60_000);
    await db.authRateBucket.createMany({
      data: Array.from({ length: 150 }, (_, index) => ({ scope: "old", keyHash: `old-${index}`, windowStart: new Date(0), count: 1, expiresAt: expired }))
    });
    const auth = await authWithFakeDelivery(async () => undefined);
    await auth.requestLoginCode("cleanup@example.test", network(61));
    expect(await db.authRateBucket.count({ where: { scope: "old" } })).toBe(50);
  });
});
