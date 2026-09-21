import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import type express from "express";
import { prisma, type User, type UserRole } from "@msva/db";
import { createSmtpLoginCodeDelivery, type LoginCodeDelivery } from "./smtp.js";

// ---------------------------------------------------------------------------
// Console authentication
//
// Email + one-time code. No passwords to leak or reset. A user is created by
// an admin (or the seed script); they sign in by requesting a 6-digit code
// for their email, which is mailed over SMTP (see smtp.ts). Only an HMAC of
// each code is stored, and only a confirmed send makes a code usable.
//
// Sessions are opaque random tokens stored hashed; the browser holds the raw
// token in an httpOnly cookie. Internal services never use this — they use
// the INTERNAL_API_TOKEN header (see routes/internal.ts).
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "msva_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_DELIVERIES = 2;
// Codes live ten minutes; finished ones are kept a day for audit, then purged.
const CODE_RETENTION_MS = 24 * 60 * 60 * 1000;
const CODE_PURGE_BATCH = 100;
// Longer than the SMTP deadline, so a send that finishes in time can activate.
const DELIVERY_LEASE_MS = 30_000;
const isProduction = () => process.env.NODE_ENV === "production";

export type SessionUser = Pick<User, "id" | "email" | "name" | "role">;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      sessionId?: string;
    }
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: string, value: string): string => createHmac("sha256", key).update(value).digest("hex");
const codeHash = (id: string, code: string): string | null => {
  const key = process.env.AUTH_CODE_HASH_KEY;
  if (!key) return null;
  return hmac(key, `${id}\0${code}`);
};
const rateHash = (value: string): string | null => {
  const key = process.env.AUTH_RATE_HASH_KEY;
  if (!key) return null;
  return hmac(key, value);
};

export type AuthNetworkContext = { address: string };
export type LoginCodeRequestResult = { ok: true; devCode?: string } | { ok: false; unavailable: true } | { ok: false; limited: true; retryAfter: number };
export type LoginCodeVerifyResult = { token: string; user: SessionUser } | null | { limited: true; retryAfter: number };
let deliveryOverride: LoginCodeDelivery | null | undefined;
/** Test-only injection point; production uses configured SMTP. */
export const setLoginCodeDeliveryForTest = (delivery: LoginCodeDelivery | null | undefined) => { deliveryOverride = delivery; };
const loginCodeDelivery = () => deliveryOverride === undefined ? createSmtpLoginCodeDelivery() : deliveryOverride;

const MAX_FORWARDED_HEADER = 512;
const MAX_FORWARDED_HOPS = 16;

/** One spelling per address, so equivalent IPv4/IPv6 forms share a rate bucket. */
export function canonicalIp(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.length > 64 || raw.includes("%")) return null;
  if (isIPv4(raw)) return raw;
  if (!isIPv6(raw)) return null;
  let host: string;
  try {
    host = new URL(`http://[${raw}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return host;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

let trustedProxyCache: { source: string; list: BlockList } | undefined;
/** TRUSTED_PROXY_ADDRESSES lists proxy addresses or CIDRs; invalid entries grant no trust. */
function trustedProxies(): BlockList {
  const source = process.env.TRUSTED_PROXY_ADDRESSES ?? "";
  if (trustedProxyCache?.source === source) return trustedProxyCache.list;
  const list = new BlockList();
  for (const entry of source.split(",").map((value) => value.trim()).filter(Boolean)) {
    const [address = "", prefix] = entry.split("/");
    const canonical = canonicalIp(address);
    if (!canonical) continue;
    const family = isIPv4(canonical) ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(canonical, family);
    else if (/^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === "ipv4" ? 32 : 128)) list.addSubnet(canonical, Number(prefix), family);
  }
  trustedProxyCache = { source, list };
  return list;
}
const isTrustedProxy = (address: string) => trustedProxies().check(address, isIPv4(address) ? "ipv4" : "ipv6");

/**
 * Client address for throttling. Forwarded headers count only when the socket
 * peer is a trusted proxy; the chain is walked from the nearest hop and the
 * first untrusted address wins, so a client-supplied prefix cannot choose it.
 * Anything malformed falls back to the peer, sharing the proxy's bucket.
 */
export function trustedNetworkFromRequest(request: express.Request): AuthNetworkContext {
  const peer = canonicalIp(request.socket.remoteAddress ?? "");
  if (!peer) return { address: "unknown" };
  const forwarded = request.get("x-forwarded-for");
  if (!forwarded || forwarded.length > MAX_FORWARDED_HEADER || !isTrustedProxy(peer)) return { address: peer };
  const hops = forwarded.split(",");
  if (hops.length > MAX_FORWARDED_HOPS) return { address: peer };
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = canonicalIp(hops[index]!);
    if (!hop) return { address: peer };
    if (!isTrustedProxy(hop)) return { address: hop };
  }
  return { address: peer };
}

/**
 * The address a rate limit counts. An IPv6 client usually holds a whole /64, so
 * counting single IPv6 addresses would let one client act as billions.
 */
export function rateAddress(address: string): string {
  if (!address.includes(":")) return address;
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).join(":")}::/64`;
}

const RATE_CLEANUP_BATCH = 100;
const windowStart = (now: Date, ms: number) => new Date(Math.floor(now.getTime() / ms) * ms);
type RateLimit = { scope: string; key: string; limit: number; windowMs: number };
async function reserveRates(limits: RateLimit[], now = new Date()): Promise<number | null> {
  const prepared = limits.map((limit) => ({ ...limit, keyHash: rateHash(limit.key), start: windowStart(now, limit.windowMs) }));
  if (prepared.some((limit) => !limit.keyHash)) return null;
  return prisma.$transaction(async (tx) => {
    // Stable lock order across keys, so concurrent multi-bucket reservations
    // cannot deadlock and every counter in the group moves together.
    for (const limit of [...prepared].sort((a, b) => `${a.scope}:${a.keyHash}`.localeCompare(`${b.scope}:${b.keyHash}`))) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${limit.scope}:${limit.keyHash}`}))`;
    }
    // All or nothing: an attempt is counted only if every bucket has room, so a
    // client hammering one limit cannot also use up a shared one (such as the
    // global hourly cap), and a denied attempt creates no rows.
    let retryAfter: number | null = null;
    for (const limit of prepared) {
      const bucket = await tx.authRateBucket.findUnique({ where: { scope_keyHash_windowStart: { scope: limit.scope, keyHash: limit.keyHash!, windowStart: limit.start } }, select: { count: true } });
      if ((bucket?.count ?? 0) >= limit.limit) retryAfter = Math.max(retryAfter ?? 0, Math.max(1, Math.ceil((limit.start.getTime() + limit.windowMs - now.getTime()) / 1000)));
    }
    if (retryAfter === null) {
      for (const limit of prepared) {
        await tx.authRateBucket.upsert({
          where: { scope_keyHash_windowStart: { scope: limit.scope, keyHash: limit.keyHash!, windowStart: limit.start } },
          create: { scope: limit.scope, keyHash: limit.keyHash!, windowStart: limit.start, count: 1, expiresAt: new Date(limit.start.getTime() + limit.windowMs + 86_400_000) },
          update: { count: { increment: 1 } }
        });
      }
    }
    // Expired buckets (a day past their window) are removed in small batches
    // rather than all at once on a hot path. The batch is chosen once: as an
    // IN subquery, Postgres may re-run it for every candidate row, and each run
    // skips the rows already deleted, so the whole table can go in one call.
    await tx.$executeRaw`WITH doomed AS MATERIALIZED (SELECT "id" FROM "AuthRateBucket" WHERE "expiresAt" < ${now} LIMIT ${RATE_CLEANUP_BATCH} FOR UPDATE SKIP LOCKED) DELETE FROM "AuthRateBucket" AS bucket USING doomed WHERE bucket."id" = doomed."id"`;
    return retryAfter;
  });
}

/**
 * The session cookie's value: undefined when absent, null when ambiguous (sent
 * twice) or malformed. Other cookies, including ones a parent domain sets, are
 * ignored, so they cannot sign anyone out.
 */
function sessionCookieValue(header: string | undefined): string | null | undefined {
  if (!header) return undefined;
  if (header.length > 8192) return null;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1 || part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    if (found !== undefined) return null;
    try {
      found = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return found;
}

/**
 * A confirmed send makes this code the user's only usable one. A code that was
 * superseded by a newer request, reclaimed or expired stays unusable, so a late
 * completion can never replace or revoke the newest code.
 */
async function activateLoginCode(userId: string, id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const now = new Date();
    const current = await tx.loginCode.findFirst({ where: { id, userId, deliveryState: "PENDING", deliveryLeaseExpiresAt: { gt: now } } });
    if (!current) {
      // Superseded or reclaimed: it stays unusable, but its send is over, so it
      // no longer holds delivery capacity.
      await tx.loginCode.updateMany({ where: { id }, data: { deliveryLeaseExpiresAt: null } });
      return;
    }
    await tx.loginCode.updateMany({ where: { userId, id: { not: id }, usedAt: null, deliveryState: "DELIVERED" }, data: { deliveryState: "FAILED" } });
    await tx.loginCode.update({ where: { id }, data: { deliveryState: "DELIVERED", deliveredAt: now, deliveryLeaseExpiresAt: null } });
  });
}

/**
 * Looks the address up and, for an active user, admits and mails one code. A
 * send holds one of the two delivery slots, shared by every API process, until
 * it finishes, even if a newer request supersedes its code. The raw code lives
 * only in memory. Returns the code for development echo, otherwise null.
 */
async function issueLoginCode(email: string, delivery: LoginCodeDelivery): Promise<string | null> {
  const user = await prisma.user.findFirst({ where: { email, active: true } });
  if (!user) return null;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const hash = codeHash(id, code);
  if (!hash) return null;
  const admitted = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"auth-delivery-cap"}))`;
    const now = new Date();
    // A crashed process leaves sends behind; their lease bounds how long they
    // hold capacity, and a code whose send never finished never becomes usable.
    await tx.loginCode.updateMany({ where: { deliveryLeaseExpiresAt: { lte: now } }, data: { deliveryState: "FAILED", deliveryLeaseExpiresAt: null } });
    if (await tx.loginCode.count({ where: { deliveryLeaseExpiresAt: { gt: now } } }) >= MAX_PENDING_DELIVERIES) return false;
    // Old codes go in bounded batches, chosen once (see reserveRates).
    await tx.$executeRaw`WITH doomed AS MATERIALIZED (SELECT "id" FROM "LoginCode" WHERE "createdAt" < ${new Date(now.getTime() - CODE_RETENTION_MS)} AND "deliveryLeaseExpiresAt" IS NULL LIMIT ${CODE_PURGE_BATCH} FOR UPDATE SKIP LOCKED) DELETE FROM "LoginCode" AS code USING doomed WHERE code."id" = doomed."id"`;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    // Older codes still pending can no longer be activated; their sends keep their slots.
    await tx.loginCode.updateMany({ where: { userId: user.id, usedAt: null, deliveryState: "PENDING" }, data: { deliveryState: "FAILED" } });
    await tx.loginCode.create({ data: { id, userId: user.id, codeHash: hash, expiresAt, deliveryLeaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS) } });
    return true;
  });
  if (!admitted) return null;
  void delivery.send({ recipient: email, code, expiresAt })
    .then(() => activateLoginCode(user.id, id))
    .catch(async () => {
      console.warn("[auth] login code delivery failed");
      await prisma.loginCode.updateMany({ where: { id, deliveryState: { in: ["PENDING", "FAILED"] } }, data: { deliveryState: "FAILED", deliveryLeaseExpiresAt: null } });
    })
    .catch(() => {
      // The database is unreachable as well: the lease expires and the next
      // request reclaims it. An uncertain send is never retried.
    });
  return code;
}

// Every address gets the same answer at the same point: the lookup, admission
// and send all happen after the response, so its timing cannot reveal whether
// an address can sign in.
export async function requestLoginCode(
  rawEmail: string,
  network: AuthNetworkContext = { address: "unknown" }
): Promise<LoginCodeRequestResult> {
  const email = rawEmail.trim().toLowerCase();
  const delivery = loginCodeDelivery();
  const configured = Boolean(delivery && process.env.AUTH_CODE_HASH_KEY && process.env.AUTH_RATE_HASH_KEY);
  if (isProduction() && !configured) return { ok: false, unavailable: true };
  const retryAfter = await reserveRates([
    { scope: "request-email-minute", key: email, limit: 1, windowMs: 60_000 },
    { scope: "request-email-hour", key: email, limit: 5, windowMs: 3_600_000 },
    { scope: "request-ip-hour", key: rateAddress(network.address), limit: 30, windowMs: 3_600_000 },
    { scope: "request-global-hour", key: "global", limit: 100, windowMs: 3_600_000 }
  ]);
  if (retryAfter) return { ok: false, limited: true, retryAfter };
  if (!configured) return { ok: true };
  if (process.env.NODE_ENV === "development" && process.env.AUTH_DEV_ECHO === "1") {
    // Development only: wait for the code so it can be shown.
    const code = await issueLoginCode(email, delivery!);
    return code ? { ok: true, devCode: code } : { ok: true };
  }
  void issueLoginCode(email, delivery!).catch(() => console.warn("[auth] login code request failed"));
  return { ok: true };
}

export async function verifyLoginCode(
  rawEmail: string,
  code: string,
  network: AuthNetworkContext = { address: "unknown" }
): Promise<LoginCodeVerifyResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^\d{6}$/.test(code)) return null;
  // Without both keys no code can be checked and no attempt can be throttled.
  if (!process.env.AUTH_CODE_HASH_KEY || !process.env.AUTH_RATE_HASH_KEY) return null;
  const retryAfter = await reserveRates([{ scope: "verify-email", key: email, limit: 10, windowMs: 600_000 }, { scope: "verify-ip", key: rateAddress(network.address), limit: 60, windowMs: 600_000 }]);
  if (retryAfter) return { limited: true, retryAfter };
  const token = randomBytes(32).toString("hex");
  // Everything that authorizes the login is read after the user and code rows
  // are locked, with the clock sampled after the locks are held. A wrong code
  // returns (not throws) so its attempt increment commits.
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findFirst({ where: { email } });
    if (!user) return null;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "LoginCode" WHERE "userId" = ${user.id} FOR UPDATE`;
    const now = new Date();
    const currentUser = await tx.user.findUnique({ where: { id: user.id } });
    if (!currentUser?.active) return null;
    const candidate = await tx.loginCode.findFirst({ where: { userId: user.id, usedAt: null, deliveryState: "DELIVERED", attempts: { lt: 5 }, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
    if (!candidate) return null;
    const candidateHash = codeHash(candidate.id, code);
    const expected = Buffer.from(candidate.codeHash, "hex");
    const given = candidateHash ? Buffer.from(candidateHash, "hex") : Buffer.alloc(0);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      await tx.loginCode.update({ where: { id: candidate.id }, data: { attempts: { increment: 1 } } });
      return null;
    }
    const claimed = await tx.loginCode.updateMany({ where: { id: candidate.id, usedAt: null, deliveryState: "DELIVERED", attempts: { lt: 5 }, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (claimed.count !== 1) return null;
    await tx.session.create({ data: { userId: currentUser.id, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + SESSION_TTL_MS) } });
    await tx.user.update({ where: { id: currentUser.id }, data: { lastLoginAt: now } });
    return { token, user: { id: currentUser.id, email: currentUser.email, name: currentUser.name, role: currentUser.role } };
  });
}

export async function revokeSession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

export function sessionCookie(token: string, maxAgeMs = SESSION_TTL_MS): string {
  const secure = isProduction() || process.env.AUTH_COOKIE_SECURE === "true";
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    secure ? "Secure" : ""
  ]
    .filter(Boolean)
    .join("; ");
}

export function tokenFromRequest(request: express.Request): string | null {
  const bearer = request.headers.authorization;
  const cookieToken = sessionCookieValue(request.headers.cookie);
  if (cookieToken === null) return null;
  if (bearer !== undefined && (!bearer.startsWith("Bearer ") || bearer.length > 512 || cookieToken)) return null;
  const token = bearer ? bearer.slice(7).trim() : cookieToken;
  return token && /^[a-f0-9]{64}$/i.test(token) ? token : null;
}

/** Attaches `request.user` when a valid session is present; never rejects. */
export async function authenticate(
  request: express.Request,
  _response: express.Response,
  next: express.NextFunction
): Promise<void> {
  try {
    const token = tokenFromRequest(request);
    if (!token) return next();
    const session = await prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true }
    });
    if (!session || session.expiresAt <= new Date() || !session.user.active) return next();
    request.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      role: session.user.role
    };
    request.sessionId = session.id;
    // Touch at most once a minute to keep writes down.
    if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
      void prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    }
    next();
  } catch (error) {
    next(error);
  }
}

const RANK: Record<UserRole, number> = { VIEWER: 0, AGENT: 1, SUPERVISOR: 2, ADMIN: 3 };

/** Rejects unless the signed-in user holds at least `minimum` role. */
export function requireRole(minimum: UserRole): express.RequestHandler {
  return (request, response, next) => {
    if (!request.user) {
      response.status(401).json({ error: "Sign in required" });
      return;
    }
    if (RANK[request.user.role] < RANK[minimum]) {
      response.status(403).json({ error: `Requires ${minimum.toLowerCase()} role` });
      return;
    }
    next();
  };
}

export async function audit(
  request: express.Request,
  action: string,
  entity: string,
  entityId?: string,
  meta?: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: request.user?.id,
        action,
        entity,
        entityId,
        meta: meta as object | undefined,
        // The trusted-chain client, not Express's request.ip: a client can prefix
        // its own X-Forwarded-For entries, and trust proxy accepts them.
        ip: trustedNetworkFromRequest(request).address
      }
    });
  } catch (error) {
    console.error("[audit] write failed", error);
  }
}
