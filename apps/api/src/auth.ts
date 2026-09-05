import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type express from "express";
import { prisma, type User, type UserRole } from "@msva/db";

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
const isProduction = process.env.NODE_ENV === "production";

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

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

// Pluggable delivery. Replace the body with an email/SMS provider call when
// one is chosen; the console fallback keeps local development working.
async function deliverLoginCode(email: string, code: string): Promise<void> {
  console.log(`[auth] login code for ${email}: ${code}`);
}

export async function requestLoginCode(
  rawEmail: string
): Promise<{ ok: true; devCode?: string }> {
  const email = rawEmail.trim().toLowerCase();
  const user = await prisma.user.findFirst({ where: { email, active: true } });
  // Always respond OK so the endpoint cannot be used to enumerate users.
  if (!user) return { ok: true };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.loginCode.create({
    data: { userId: user.id, codeHash: sha256(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) }
  });
  await deliverLoginCode(email, code);
  const echo = !isProduction || process.env.AUTH_DEV_ECHO === "1";
  return echo ? { ok: true, devCode: code } : { ok: true };
}

export async function verifyLoginCode(
  rawEmail: string,
  code: string
): Promise<{ token: string; user: SessionUser } | null> {
  const email = rawEmail.trim().toLowerCase();
  const user = await prisma.user.findFirst({ where: { email, active: true } });
  if (!user) return null;

  const candidate = await prisma.loginCode.findFirst({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" }
  });
  if (!candidate) return null;

  const expected = Buffer.from(candidate.codeHash, "hex");
  const given = Buffer.from(sha256(code.trim()), "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  const token = randomBytes(32).toString("hex");
  await prisma.$transaction([
    prisma.loginCode.update({ where: { id: candidate.id }, data: { usedAt: new Date() } }),
    prisma.session.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) }
    }),
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
  ]);

  return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
}

export async function revokeSession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

export function sessionCookie(token: string, maxAgeMs = SESSION_TTL_MS): string {
  const secure = isProduction || process.env.AUTH_COOKIE_SECURE === "true";
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
  if (bearer?.startsWith("Bearer ")) return bearer.slice(7).trim();
  return parseCookies(request.headers.cookie)[SESSION_COOKIE] ?? null;
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
