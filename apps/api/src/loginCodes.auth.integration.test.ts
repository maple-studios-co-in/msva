import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@msva/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.MSVA_AUTH_TEST_DATABASE_URL;
// These tests delete users and sessions: only ever against the disposable database,
// and only when the app's own connection points at the same one.
if (!databaseUrl || databaseUrl !== process.env.DATABASE_URL || !new URL(databaseUrl).pathname.endsWith("/msva_auth_test")) {
  throw new Error("DATABASE_URL and MSVA_AUTH_TEST_DATABASE_URL must match the disposable msva_auth_test database");
}
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

/** Resolves once exactly `count` database sessions are blocked waiting for a lock. */
async function lockWaiters(count: number) {
  await vi.waitFor(async () => {
    const [row] = await db.$queryRaw<{ waiting: bigint }[]>`SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    expect(Number(row!.waiting)).toBe(count);
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

/**
 * Runs `work` while Postgres prefers plans that re-run a subquery once per outer
 * row, as it may choose on real table statistics. The app's pool reconnects so
 * its sessions pick the settings up.
 */
async function withRescanningPlans(work: () => Promise<void>) {
  const settings = ["enable_material", "enable_hashjoin", "enable_mergejoin", "enable_hashagg", "enable_sort", "enable_indexscan", "enable_bitmapscan"];
  const { prisma } = await import("@msva/db");
  for (const name of settings) await db.$executeRawUnsafe(`ALTER DATABASE msva_auth_test SET ${name} = off`);
  await prisma.$disconnect();
  try {
    await work();
  } finally {
    for (const name of settings) await db.$executeRawUnsafe(`ALTER DATABASE msva_auth_test RESET ${name}`);
    await prisma.$disconnect();
  }
}

/** Runs `work` with the app's database sessions in a time zone other than UTC. */
async function withDatabaseTimeZone(zone: string, work: () => Promise<void>) {
  const { prisma } = await import("@msva/db");
  await db.$executeRawUnsafe(`ALTER DATABASE msva_auth_test SET timezone = '${zone}'`);
  await prisma.$disconnect();
  try {
    await work();
  } finally {
    await db.$executeRawUnsafe("ALTER DATABASE msva_auth_test RESET timezone");
    await prisma.$disconnect();
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

  it("purges day-old codes in bounded batches and keeps recent codes and live sends", async () => {
    const past = await db.user.create({ data: { email: "past@example.test", name: "Past", role: "AGENT" } });
    const dayAgo = new Date(Date.now() - 25 * 3_600_000);
    const row = (overrides: object) => ({ id: randomBytes(24).toString("hex"), userId: past.id, codeHash: "0".repeat(64), expiresAt: dayAgo, deliveryState: "DELIVERED" as const, createdAt: dayAgo, ...overrides });
    await db.loginCode.createMany({ data: Array.from({ length: 150 }, () => row({})) });
    const recent = await db.loginCode.create({ data: row({ createdAt: new Date(Date.now() - 3_600_000) }) });
    const sending = await db.loginCode.create({ data: row({ deliveryState: "PENDING", deliveryLeaseExpiresAt: new Date(Date.now() + 60_000) }) });
    await withRescanningPlans(async () => {
      await deliveredLogin("purge@example.test");
    });
    expect(await db.loginCode.count({ where: { userId: past.id, createdAt: dayAgo, deliveryLeaseExpiresAt: null } })).toBe(50);
    expect(await db.loginCode.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await db.loginCode.findUnique({ where: { id: sending.id } })).not.toBeNull();
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
    await vi.waitFor(() => expect(inFlight).toBe(2));
    await settle(200);
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

  it("does not deadlock with a request that reclaims the same user's abandoned send", async () => {
    const { user, auth, code } = await deliveredLogin("reclaim@example.test");
    // A send abandoned by a crashed process.
    await db.loginCode.create({ data: { id: randomBytes(24).toString("hex"), userId: user.id, codeHash: "0".repeat(64), expiresAt: new Date(Date.now() + 600_000), deliveryLeaseExpiresAt: new Date(Date.now() - 1_000) } });
    let verifying!: ReturnType<typeof auth.verifyLoginCode>;
    // Both wait for the user lock, verification first. The request has already
    // claimed the abandoned send, which verification must not then wait for.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
      verifying = auth.verifyLoginCode(user.email, code, network(42));
      await lockWaiters(1);
      await auth.requestLoginCode(user.email, network(43));
      await lockWaiters(2);
    }, { timeout: 15_000 });
    expect(await verifying).toMatchObject({ token: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await vi.waitFor(async () => expect(await db.loginCode.count({ where: { userId: user.id, deliveryState: "DELIVERED", usedAt: null } })).toBe(1), { timeout: 5_000 });
  });

  it("does not deadlock with a request that purges the same user's day-old code", async () => {
    const { user, auth, code } = await deliveredLogin("purge-race@example.test");
    // Delivered a day ago and never used: the request purges it.
    const dayAgo = new Date(Date.now() - 25 * 3_600_000);
    const stale = await db.loginCode.create({ data: { id: randomBytes(24).toString("hex"), userId: user.id, codeHash: "0".repeat(64), deliveryState: "DELIVERED", expiresAt: dayAgo, createdAt: dayAgo } });
    let verifying!: ReturnType<typeof auth.verifyLoginCode>;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
      verifying = auth.verifyLoginCode(user.email, code, network(44));
      await lockWaiters(1);
      await auth.requestLoginCode(user.email, network(45));
      await lockWaiters(2);
    }, { timeout: 15_000 });
    expect(await verifying).toMatchObject({ token: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await vi.waitFor(async () => expect(await db.loginCode.count({ where: { userId: user.id, deliveryState: "DELIVERED", usedAt: null, id: { not: stale.id } } })).toBe(1), { timeout: 5_000 });
    expect(await db.loginCode.findUnique({ where: { id: stale.id } })).toBeNull();
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

  it("keeps windows and expiry in UTC whatever the database's time zone", async () => {
    const user = await db.user.create({ data: { email: "zone@example.test", name: "Zone", role: "AGENT" } });
    const code = (hoursAgo: number) => ({ id: randomBytes(24).toString("hex"), userId: user.id, codeHash: "0".repeat(64), deliveryState: "DELIVERED" as const, expiresAt: new Date(Date.now() - hoursAgo * 3_600_000), createdAt: new Date(Date.now() - hoursAgo * 3_600_000) });
    const recent = code(20);
    const old = code(25);
    await db.loginCode.createMany({ data: [recent, old] });
    await db.authRateBucket.createMany({ data: [
      { scope: "old", keyHash: "live", windowStart: new Date(0), count: 1, expiresAt: new Date(Date.now() + 3_600_000) },
      { scope: "old", keyHash: "expired", windowStart: new Date(0), count: 1, expiresAt: new Date(Date.now() - 3_600_000) }
    ] });
    await withDatabaseTimeZone("Asia/Kolkata", async () => {
      const auth = await authWithFakeDelivery(async () => undefined);
      const before = Date.now();
      expect(await auth.requestLoginCode(user.email, network(84))).toEqual({ ok: true });
      const after = Date.now();
      await vi.waitFor(async () => expect(await db.loginCode.count({ where: { userId: user.id, id: { notIn: [recent.id, old.id] }, deliveryState: "DELIVERED" } })).toBe(1));
      const minute = await db.authRateBucket.findFirstOrThrow({ where: { scope: "request-email-minute" } });
      expect([before, after].map((at) => Math.floor(at / 60_000) * 60_000)).toContain(minute.windowStart.getTime());
    });
    expect((await db.authRateBucket.findMany({ where: { scope: "old" } })).map((bucket) => bucket.keyHash)).toEqual(["live"]);
    expect(await db.loginCode.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await db.loginCode.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it("answers a reserved request even when expired-bucket cleanup fails", async () => {
    await db.authRateBucket.create({ data: { scope: "old", keyHash: "expired", windowStart: new Date(0), count: 1, expiresAt: new Date(Date.now() - 60_000) } });
    await db.$executeRawUnsafe(`CREATE FUNCTION fail_rate_bucket_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'auth test cleanup failure'; END; $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER fail_rate_bucket_delete BEFORE DELETE ON "AuthRateBucket" FOR EACH ROW EXECUTE FUNCTION fail_rate_bucket_delete()`);
    try {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const auth = await authWithFakeDelivery(async () => undefined);
      expect(await auth.requestLoginCode("cleanup@example.test", network(96))).toEqual({ ok: true });
      expect(await auth.verifyLoginCode("cleanup@example.test", "123456", network(96))).toBeNull();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_rate_bucket_delete ON "AuthRateBucket"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS fail_rate_bucket_delete()`);
    }
  });

  it("removes expired buckets in bounded batches", async () => {
    const expired = new Date(Date.now() - 60_000);
    await db.authRateBucket.createMany({
      data: Array.from({ length: 150 }, (_, index) => ({ scope: "old", keyHash: `old-${index}`, windowStart: new Date(0), count: 1, expiresAt: expired }))
    });
    const auth = await authWithFakeDelivery(async () => undefined);
    await withRescanningPlans(async () => {
      await auth.requestLoginCode("cleanup@example.test", network(61));
    });
    expect(await db.authRateBucket.count({ where: { scope: "old" } })).toBe(50);
  });
});

describe("abuse resistance", () => {
  it("never holds the shared hourly bucket while a client waits on its own limits", async () => {
    const auth = await authWithFakeDelivery(async () => undefined);
    await auth.requestLoginCode("contended@example.test", network(82));
    await db.authRateBucket.deleteMany({ where: { scope: "request-email-minute" } });
    let contended!: ReturnType<typeof auth.requestLoginCode>;
    await db.$transaction(async (tx) => {
      // The contended client's own hourly bucket is busy, so its reservation waits.
      await tx.$queryRaw`SELECT "id" FROM "AuthRateBucket" WHERE "scope" = 'request-email-hour' FOR UPDATE`;
      contended = auth.requestLoginCode("contended@example.test", network(82));
      await lockWaiters(1);
      // Meanwhile anyone else is still admitted.
      expect(await auth.requestLoginCode("bystander@example.test", network(83))).toEqual({ ok: true });
    }, { timeout: 15_000 });
    expect(await contended).toEqual({ ok: true });
  });

  it("writes nothing for a request some bucket has no room for", async () => {
    const auth = await authWithFakeDelivery(async () => undefined);
    for (let index = 0; index < 30; index += 1) expect(await auth.requestLoginCode(`flood${index}@example.test`, network(97))).toEqual({ ok: true });
    for (let index = 0; index < 60; index += 1) expect(await auth.verifyLoginCode(`probe${index}@example.test`, "123456", network(98))).toBeNull();
    // A sequence moves on even when the transaction that called it rolls back.
    await db.$executeRawUnsafe(`CREATE SEQUENCE rate_bucket_writes`);
    await db.$executeRawUnsafe(`CREATE FUNCTION count_rate_bucket_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('rate_bucket_writes'); RETURN NEW; END; $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER count_rate_bucket_write BEFORE INSERT OR UPDATE ON "AuthRateBucket" FOR EACH ROW EXECUTE FUNCTION count_rate_bucket_write()`);
    try {
      // Fresh addresses, each with room in its own buckets, from clients that have none.
      for (let index = 30; index < 40; index += 1) expect(await auth.requestLoginCode(`flood${index}@example.test`, network(97))).toMatchObject({ ok: false, limited: true });
      for (let index = 60; index < 70; index += 1) expect(await auth.verifyLoginCode(`probe${index}@example.test`, "123456", network(98))).toMatchObject({ limited: true });
      const [sequence] = await db.$queryRaw<{ is_called: boolean }[]>`SELECT is_called FROM rate_bucket_writes`;
      expect(sequence!.is_called).toBe(false);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS count_rate_bucket_write ON "AuthRateBucket"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS count_rate_bucket_write()`);
      await db.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS rate_bucket_writes`);
    }
  });

  it("counts every address in one IPv6 /64 as one client", async () => {
    const auth = await authWithFakeDelivery(async () => undefined);
    const inSubnet = (n: number) => ({ address: `2001:db8:1:2::${n.toString(16)}` });
    const otherSubnet = { address: "2001:db8:1:3::1" };
    for (let index = 1; index <= 30; index += 1) expect(await auth.requestLoginCode(`subnet${index}@example.test`, inSubnet(index))).toEqual({ ok: true });
    expect(await auth.requestLoginCode("subnet-extra@example.test", inSubnet(0xffff))).toMatchObject({ ok: false, limited: true });
    expect(await auth.requestLoginCode("subnet-other@example.test", otherSubnet)).toEqual({ ok: true });
    for (let index = 1; index <= 60; index += 1) expect(await auth.verifyLoginCode(`verify${index % 6}@example.test`, "000000", inSubnet(index))).toBeNull();
    expect(await auth.verifyLoginCode("verify-extra@example.test", "000000", inSubnet(0xfffe))).toMatchObject({ limited: true });
    expect(await auth.verifyLoginCode("verify-extra@example.test", "000000", otherSubnet)).toBeNull();
  });

  it("does not let one client's flood lock everyone else out", async () => {
    const auth = await authWithFakeDelivery(async () => undefined);
    for (let index = 0; index < 120; index += 1) await auth.requestLoginCode("victim@example.test", network(70));
    const others = await db.authRateBucket.findMany({ where: { scope: "request-global-hour" } });
    expect(others.reduce((total, bucket) => total + bucket.count, 0)).toBeLessThanOrEqual(30);
    const user = await db.user.create({ data: { email: "someone@example.test", name: "Someone", role: "AGENT" } });
    expect(await auth.requestLoginCode(user.email, network(71))).toEqual({ ok: true });
    await vi.waitFor(async () => expect(await db.loginCode.count({ where: { userId: user.id, deliveryState: "DELIVERED" } })).toBe(1));
  });

  it("creates no rate rows for denied attempts", async () => {
    const auth = await authWithFakeDelivery(async () => undefined);
    for (let index = 0; index < 200; index += 1) await auth.requestLoginCode(`fresh${index}@example.test`, network(72));
    // 30 admitted fresh emails (minute and hour rows each), one IP row and one global row.
    expect(await db.authRateBucket.count()).toBeLessThanOrEqual(62);
  });

  it("answers before looking the address up, so timing cannot reveal it", async () => {
    const user = await db.user.create({ data: { email: "timing@example.test", name: "Timing", role: "AGENT" } });
    const auth = await authWithFakeDelivery(async () => undefined);
    // Admitting a code for this user needs its row lock; the answer must not wait for it.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
      const started = Date.now();
      await expect(auth.requestLoginCode(user.email, network(73))).resolves.toEqual({ ok: true });
      await expect(auth.requestLoginCode("nobody@example.test", network(74))).resolves.toEqual({ ok: true });
      expect(Date.now() - started).toBeLessThan(2_000);
    }, { timeout: 15_000 });
    await vi.waitFor(async () => expect(await db.loginCode.count({ where: { userId: user.id, deliveryState: "DELIVERED" } })).toBe(1));
  });

  it("keeps a superseded send's delivery slot until it finishes", async () => {
    const first = await db.user.create({ data: { email: "twice@example.test", name: "Twice", role: "AGENT" } });
    const other = await db.user.create({ data: { email: "third@example.test", name: "Third", role: "AGENT" } });
    const releases: Array<() => void> = [];
    let sends = 0;
    const auth = await authWithFakeDelivery(async () => {
      sends += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
    });
    await auth.requestLoginCode(first.email, network(75));
    await vi.waitFor(() => expect(sends).toBe(1));
    await db.authRateBucket.deleteMany();
    await auth.requestLoginCode(first.email, network(76));
    await vi.waitFor(() => expect(sends).toBe(2));
    // Two sends are in flight even though the first code was superseded: no third.
    await auth.requestLoginCode(other.email, network(77));
    await settle(300);
    expect(sends).toBe(2);
    expect(await db.loginCode.count({ where: { userId: other.id } })).toBe(0);
    releases.forEach((release) => release());
    await vi.waitFor(async () => expect(await db.loginCode.count({ where: { deliveryLeaseExpiresAt: { not: null } } })).toBe(0));
  });

  it("frees a superseded code's delivery slot when its send fails", async () => {
    const user = await db.user.create({ data: { email: "failing@example.test", name: "Failing", role: "AGENT" } });
    const sends: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const auth = await authWithFakeDelivery(() => new Promise<void>((resolve, reject) => { sends.push({ resolve, reject }); }));
    await auth.requestLoginCode(user.email, network(80));
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await db.authRateBucket.deleteMany();
    await auth.requestLoginCode(user.email, network(81));
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    const superseded = await db.loginCode.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    expect(superseded.deliveryState).toBe("FAILED");
    expect(superseded.deliveryLeaseExpiresAt).not.toBeNull();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sends[0]!.reject(new Error("SMTP unavailable"));
    await vi.waitFor(async () => expect((await db.loginCode.findUniqueOrThrow({ where: { id: superseded.id } })).deliveryLeaseExpiresAt).toBeNull());
    sends[1]!.resolve();
    await vi.waitFor(async () => expect(await db.loginCode.count({ where: { userId: user.id, deliveryState: "DELIVERED" } })).toBe(1));
  });

  it("echoes a code only in development with echo enabled", async () => {
    const user = await db.user.create({ data: { email: "echo@example.test", name: "Echo", role: "AGENT" } });
    process.env.AUTH_DEV_ECHO = "1";
    try {
      for (const nodeEnv of ["production", "test", undefined]) {
        await db.authRateBucket.deleteMany();
        if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
        const auth = await authWithFakeDelivery(async () => undefined);
        expect(await auth.requestLoginCode(user.email, network(78))).toEqual({ ok: true });
      }
      await db.authRateBucket.deleteMany();
      process.env.NODE_ENV = "development";
      const auth = await authWithFakeDelivery(async () => undefined);
      expect(await auth.requestLoginCode(user.email, network(79))).toMatchObject({ ok: true, devCode: expect.stringMatching(/^\d{6}$/) });
    } finally {
      delete process.env.AUTH_DEV_ECHO;
      process.env.NODE_ENV = "development";
    }
  });
});

describe("user administration", () => {
  it("refuses a new user's email longer than 254 characters", async () => {
    const token = randomBytes(32).toString("hex");
    const admin = await db.user.create({ data: { email: "admin@example.test", name: "Admin", role: "ADMIN" } });
    await db.session.create({ data: { userId: admin.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 3_600_000) } });
    const { default: express } = await import("express");
    const { adminRouter } = await import("./routes/admin.js");
    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminRouter);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const create = (email: string) => fetch(`http://127.0.0.1:${port}/api/admin/users`, { method: "POST", headers: { "content-type": "application/json", cookie: `msva_session=${token}` }, body: JSON.stringify({ email, name: "New", role: "AGENT" }) });
    const longest = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(62)}.test`;
    expect(longest).toHaveLength(254);
    try {
      expect((await create(`a${longest}`)).status).toBe(400);
      expect((await create(longest)).status).toBe(201);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
