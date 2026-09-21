import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type express from "express";
import { prisma, type User, type UserRole } from "@msva/db";
import { createSmtpLoginCodeDelivery, type LoginCodeDelivery } from "./smtp.js";

// ---------------------------------------------------------------------------
// Console authentication
//
// Email + one-time code. No passwords to leak or reset. A user is created by
// an admin (or the seed script); they sign in by requesting a 6-digit code
// for their email, which is delivered by `deliverLoginCode` — console output
// in development, an email/SMS provider in production (see sendLoginCode).
//
// Sessions are opaque random tokens stored hashed; the browser holds the raw
// token in an httpOnly cookie. Internal services never use this — they use
// the INTERNAL_API_TOKEN header (see routes/internal.ts).
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "msva_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
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
let deliveryOverride: LoginCodeDelivery | null | undefined;
/** Test-only injection point; production uses configured SMTP. */
export const setLoginCodeDeliveryForTest = (delivery: LoginCodeDelivery | null | undefined) => { deliveryOverride = delivery; };
const loginCodeDelivery = () => deliveryOverride === undefined ? createSmtpLoginCodeDelivery() : deliveryOverride;

export function trustedNetworkFromRequest(request: express.Request): AuthNetworkContext {
  const socketAddress = request.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "unknown";
  const trusted = new Set((process.env.TRUSTED_PROXY_ADDRESSES ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  const forwarded = request.get("x-forwarded-for");
  if (!trusted.has(socketAddress) || !forwarded || forwarded.length > 512) return { address: socketAddress };
  const candidate = forwarded.split(",")[0]?.trim().replace(/^::ffff:/, "");
  return candidate && /^[0-9a-f:.]+$/i.test(candidate) ? { address: candidate } : { address: socketAddress };
}

const windowStart = (now: Date, ms: number) => new Date(Math.floor(now.getTime() / ms) * ms);
async function reserveRate(scope: string, key: string, limit: number, windowMs: number, now = new Date()): Promise<number | null> {
  const keyHash = rateHash(key);
  if (!keyHash) return null;
  const start = windowStart(now, windowMs);
  const bucket = await prisma.authRateBucket.upsert({
    where: { scope_keyHash_windowStart: { scope, keyHash, windowStart: start } },
    create: { scope, keyHash, windowStart: start, count: 1, expiresAt: new Date(start.getTime() + windowMs + 86_400_000) },
    update: { count: { increment: 1 } }
  });
  return bucket.count > limit ? Math.max(1, Math.ceil((start.getTime() + windowMs - now.getTime()) / 1000)) : null;
}

function parseCookies(header: string | undefined): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (!header) return out;
  if (header.length > 8192) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    if (Object.hasOwn(out, key)) return null;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return out;
}

// Pluggable delivery. Replace the body with an email/SMS provider call when
// one is chosen; the console fallback keeps local development working.
export async function requestLoginCode(
  rawEmail: string,
  network: AuthNetworkContext = { address: "unknown" }
): Promise<LoginCodeRequestResult> {
  const email = rawEmail.trim().toLowerCase();
  const delivery = loginCodeDelivery();
  if (isProduction() && (!delivery || !process.env.AUTH_CODE_HASH_KEY || !process.env.AUTH_RATE_HASH_KEY)) return { ok: false, unavailable: true };
  const minute = await reserveRate("request-email-minute", email, 1, 60_000);
  const hour = await reserveRate("request-email-hour", email, 5, 3_600_000);
  const ip = await reserveRate("request-ip-hour", network.address, 30, 3_600_000);
  if (minute || hour || ip) return { ok: false, limited: true, retryAfter: Math.max(minute ?? 0, hour ?? 0, ip ?? 0) };
  const user = await prisma.user.findFirst({ where: { email, active: true } });
  // Always respond OK so the endpoint cannot be used to enumerate users.
  if (!user) return { ok: true };

  if (!delivery || !process.env.AUTH_CODE_HASH_KEY || !process.env.AUTH_RATE_HASH_KEY) return { ok: true };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const id = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const hash = codeHash(id, code);
  if (!hash) return { ok: false, unavailable: true };
  await prisma.$transaction(async (tx) => {
    await tx.loginCode.updateMany({ where: { userId: user.id, usedAt: null, deliveryState: "PENDING" }, data: { deliveryState: "FAILED", deliveryLeaseExpiresAt: null } });
    await tx.loginCode.create({ data: { id, userId: user.id, codeHash: hash, expiresAt, deliveryLeaseExpiresAt: new Date(Date.now() + 30_000) } });
  });
  void delivery.send({ recipient: email, code, expiresAt }).then(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.loginCode.updateMany({ where: { userId: user.id, id: { not: id }, usedAt: null, deliveryState: "DELIVERED" }, data: { deliveryState: "FAILED" } });
      await tx.loginCode.updateMany({ where: { id, deliveryState: "PENDING" }, data: { deliveryState: "DELIVERED", deliveredAt: new Date(), deliveryLeaseExpiresAt: null } });
    });
  }).catch(async () => { await prisma.loginCode.updateMany({ where: { id, deliveryState: "PENDING" }, data: { deliveryState: "FAILED", deliveryLeaseExpiresAt: null } }); });
  const echo = process.env.NODE_ENV === "development" && process.env.AUTH_DEV_ECHO === "1";
  return echo ? { ok: true, devCode: code } : { ok: true };
}

export async function verifyLoginCode(
  rawEmail: string,
  code: string,
  network: AuthNetworkContext = { address: "unknown" }
): Promise<{ token: string; user: SessionUser } | null> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^\d{6}$/.test(code)) return null;
  const emailLimit = await reserveRate("verify-email", email, 10, 600_000);
  const ipLimit = await reserveRate("verify-ip", network.address, 60, 600_000);
  if (emailLimit || ipLimit) return null;
  const user = await prisma.user.findFirst({ where: { email, active: true } });
  if (!user) return null;

  const candidate = await prisma.loginCode.findFirst({
    where: { userId: user.id, usedAt: null, deliveryState: "DELIVERED", attempts: { lt: 5 }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" }
  });
  if (!candidate) return null;

  const expected = Buffer.from(candidate.codeHash, "hex");
  const candidateHash = codeHash(candidate.id, code);
  if (!candidateHash) return null;
  const given = Buffer.from(candidateHash, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    await prisma.loginCode.updateMany({ where: { id: candidate.id, usedAt: null, deliveryState: "DELIVERED", attempts: { lt: 5 } }, data: { attempts: { increment: 1 } } });
    return null;
  }

  const token = randomBytes(32).toString("hex");
  const consumed = await prisma.$transaction(async (tx) => {
    const claimed = await tx.loginCode.updateMany({ where: { id: candidate.id, usedAt: null, deliveryState: "DELIVERED", expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) return false;
    await tx.session.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return true;
  });
  if (!consumed) return null;

  return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
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
  const cookies = parseCookies(request.headers.cookie);
  if (!cookies) return null;
  const cookieToken = cookies[SESSION_COOKIE];
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
    if (!session || session.expiresAt < new Date() || !session.user.active) return next();
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
        ip: request.ip
      }
    });
  } catch (error) {
    console.error("[audit] write failed", error);
  }
}
