import express from "express";
import { z } from "zod";
import { prisma, type Prisma, type TicketStatus } from "@msva/db";
import {
  audit,
  authenticate,
  requestLoginCode,
  requireRole,
  revokeSession,
  sessionCookie,
  tokenFromRequest,
  verifyLoginCode
} from "../auth.js";

// ---------------------------------------------------------------------------
// Admin console API — everything the console UI reads and writes.
//
// Role model (see docs/platform-plan): viewer < agent < supervisor < admin.
//   viewer      read overview, calls, tickets
//   agent       + work tickets assigned to them or unassigned
//   supervisor  + assign any ticket, mark calls as test, QA actions
//   admin       + users, audit log
// ---------------------------------------------------------------------------

export const adminRouter = express.Router();
adminRouter.use(authenticate);

const bad = (response: express.Response, error: z.ZodError) =>
  response.status(400).json({ error: "Invalid request", details: error.flatten() });

const pageOf = (query: Record<string, unknown>) => {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

const dateOrUndefined = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const emailSchema = z.object({ email: z.string().email() });

adminRouter.post("/auth/request-code", async (request, response, next) => {
  const parsed = emailSchema.safeParse(request.body);
  if (!parsed.success) return void bad(response, parsed.error);
  try {
    response.json(await requestLoginCode(parsed.data.email));
  } catch (error) {
    next(error);
  }
});

const verifySchema = z.object({ email: z.string().email(), code: z.string().min(4).max(12) });

adminRouter.post("/auth/verify", async (request, response, next) => {
  const parsed = verifySchema.safeParse(request.body);
  if (!parsed.success) return void bad(response, parsed.error);
  try {
    const result = await verifyLoginCode(parsed.data.email, parsed.data.code);
    if (!result) {
      response.status(401).json({ error: "That code is wrong or has expired. Request a new one." });
      return;
    }
    response.setHeader("Set-Cookie", sessionCookie(result.token));
    request.user = result.user;
    await audit(request, "auth.login", "user", result.user.id);
    response.json({ user: result.user });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/auth/logout", async (request, response, next) => {
  try {
    const token = tokenFromRequest(request);
    if (token) await revokeSession(token);
    response.setHeader("Set-Cookie", sessionCookie("", 0));
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/me", (request, response) => {
  if (!request.user) {
    response.status(401).json({ error: "Sign in required" });
    return;
  }
  response.json({ user: request.user });
});

// Everything below needs a signed-in user.
adminRouter.use(requireRole("VIEWER"));

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

adminRouter.get("/overview", async (_request, response, next) => {
  try {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const live = { isTest: false };
    const [callsToday, transferredToday, liveNow, openTickets, slaBreaches, ttfw, outcomes] = await Promise.all([
      prisma.call.count({ where: { ...live, startedAt: { gte: dayStart } } }),
      prisma.call.count({ where: { ...live, startedAt: { gte: dayStart }, outcome: "HUMAN_TRANSFER" } }),
      prisma.call.count({ where: { ...live, status: "IN_PROGRESS", endedAt: null } }),
      prisma.ticket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS", "WAITING"] } } }),
      prisma.ticket.count({
        where: { status: { in: ["OPEN", "IN_PROGRESS", "WAITING"] }, slaDueAt: { lt: new Date() } }
      }),
      prisma.turn.aggregate({
        _avg: { ttfwMs: true },
        where: { call: { ...live, startedAt: { gte: dayStart } }, ttfwMs: { not: null } }
      }),
      prisma.call.groupBy({
        by: ["outcome"],
        _count: { _all: true },
        where: { ...live, startedAt: { gte: dayStart } }
      })
    ]);
    response.json({
      today: {
        calls: callsToday,
        transferred: transferredToday,
        handledByAgent: callsToday - transferredToday,
        avgTtfwMs: ttfw._avg.ttfwMs ? Math.round(ttfw._avg.ttfwMs) : null,
        outcomes: Object.fromEntries(outcomes.map((row) => [row.outcome, row._count._all]))
      },
      liveNow,
      tickets: { open: openTickets, slaBreaches }
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

adminRouter.get("/calls", async (request, response, next) => {
  try {
    const { page, pageSize, skip, take } = pageOf(request.query as Record<string, unknown>);
    const q = request.query as Record<string, string | undefined>;
    const where: Prisma.CallWhereInput = {};
    if (q.isTest !== "all") where.isTest = q.isTest === "true";
    if (q.status) where.status = q.status.toUpperCase() as Prisma.CallWhereInput["status"];
    if (q.outcome) where.outcome = q.outcome.toUpperCase() as Prisma.CallWhereInput["outcome"];
    if (q.intent) where.intent = q.intent;
    if (q.callerType) where.callerType = q.callerType.toUpperCase() as Prisma.CallWhereInput["callerType"];
    const from = dateOrUndefined(q.from);
    const to = dateOrUndefined(q.to);
    if (from || to) where.startedAt = { gte: from, lte: to };
    if (q.q) {
      const needle = q.q.trim();
      const asNumber = Number(needle.replace(/^tkt-?/i, ""));
      where.OR = [
        { fromNumber: { contains: needle } },
        { callerName: { contains: needle, mode: "insensitive" } },
        ...(Number.isInteger(asNumber) ? [{ tickets: { some: { number: asNumber } } }] : [])
      ];
    }

    const [total, items] = await Promise.all([
      prisma.call.count({ where }),
      prisma.call.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip,
        take,
        select: {
          id: true,
          provider: true,
          direction: true,
          isTest: true,
          status: true,
          outcome: true,
          fromNumber: true,
          callerName: true,
          callerType: true,
          intent: true,
          escalationReason: true,
          startedAt: true,
          endedAt: true,
          durationMs: true,
          costPaise: true,
          agent: { select: { id: true, name: true } },
          caller: { select: { id: true, name: true, type: true, code: true, area: true } },
          tickets: { select: { id: true, number: true, status: true } },
          _count: { select: { turns: true } }
        }
      })
    ]);
    response.json({ items, page, pageSize, total });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/calls/:id", async (request, response, next) => {
  try {
    const call = await prisma.call.findUnique({
      where: { id: String(request.params.id) },
      include: {
        agent: true,
        caller: true,
        turns: { orderBy: { index: "asc" } },
        utterances: { orderBy: { seq: "asc" } },
        tickets: { include: { assignee: { select: { id: true, name: true } } } }
      }
    });
    if (!call) {
      response.status(404).json({ error: "Call not found" });
      return;
    }
    response.json(call);
  } catch (error) {
    next(error);
  }
});

const callPatchSchema = z.object({ isTest: z.boolean().optional() });

adminRouter.patch("/calls/:id", requireRole("SUPERVISOR"), async (request, response, next) => {
  const parsed = callPatchSchema.safeParse(request.body);
  if (!parsed.success) return void bad(response, parsed.error);
  try {
    const call = await prisma.call.update({ where: { id: String(request.params.id) }, data: parsed.data });
    await audit(request, "call.update", "call", call.id, parsed.data);
    response.json(call);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

const ticketInclude = {
  assignee: { select: { id: true, name: true, email: true } },
  caller: { select: { id: true, name: true, type: true, code: true, area: true } },
  call: { select: { id: true, startedAt: true, outcome: true, intent: true } }
} satisfies Prisma.TicketInclude;

adminRouter.get("/tickets", async (request, response, next) => {
  try {
    const { page, pageSize, skip, take } = pageOf(request.query as Record<string, unknown>);
    const q = request.query as Record<string, string | undefined>;
    const where: Prisma.TicketWhereInput = {};
    if (q.status === "open") where.status = { in: ["OPEN", "IN_PROGRESS", "WAITING"] };
    else if (q.status) where.status = q.status.toUpperCase() as TicketStatus;
    if (q.priority) where.priority = q.priority.toUpperCase() as Prisma.TicketWhereInput["priority"];
    if (q.assigneeId === "me" && request.user) where.assigneeId = request.user.id;
    else if (q.assigneeId === "none") where.assigneeId = null;
    else if (q.assigneeId) where.assigneeId = q.assigneeId;
    if (q.intent) where.intent = q.intent;
    if (q.q) {
      const needle = q.q.trim();
      const asNumber = Number(needle.replace(/^tkt-?/i, ""));
      where.OR = [
        { phone: { contains: needle } },
        { callerName: { contains: needle, mode: "insensitive" } },
        { summary: { contains: needle, mode: "insensitive" } },
        ...(Number.isInteger(asNumber) ? [{ number: asNumber }] : [])
      ];
    }
    const [total, items] = await Promise.all([
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        orderBy: [{ status: "asc" }, { priority: "desc" }, { createdAt: "desc" }],
        skip,
        take,
        include: ticketInclude
      })
    ]);
    response.json({ items, page, pageSize, total });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/tickets/:id", async (request, response, next) => {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: String(request.params.id) },
      include: {
        ...ticketInclude,
        notes: { orderBy: { createdAt: "asc" }, include: { author: { select: { id: true, name: true } } } }
      }
    });
    if (!ticket) {
      response.status(404).json({ error: "Ticket not found" });
      return;
    }
    response.json(ticket);
  } catch (error) {
    next(error);
  }
});

const ticketPatchSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  assigneeId: z.string().nullable().optional(),
  callbackStart: z.string().datetime().nullable().optional(),
  callbackEnd: z.string().datetime().nullable().optional(),
  slaDueAt: z.string().datetime().nullable().optional(),
  resolutionCode: z.string().max(64).nullable().optional()
});

adminRouter.patch("/tickets/:id", requireRole("AGENT"), async (request, response, next) => {
  const parsed = ticketPatchSchema.safeParse(request.body);
  if (!parsed.success) return void bad(response, parsed.error);
  try {
    const existing = await prisma.ticket.findUnique({ where: { id: String(request.params.id) } });
    if (!existing) {
      response.status(404).json({ error: "Ticket not found" });
      return;
    }
    const user = request.user!;
    if (user.role === "AGENT") {
      const mine = !existing.assigneeId || existing.assigneeId === user.id;
      const reassigning = parsed.data.assigneeId !== undefined && parsed.data.assigneeId !== user.id;
      if (!mine || reassigning) {
        response.status(403).json({ error: "Agents can only work tickets assigned to them or unassigned" });
        return;
      }
    }
    const { callbackStart, callbackEnd, slaDueAt, ...rest } = parsed.data;
    const data: Prisma.TicketUpdateInput = { ...rest };
    if (callbackStart !== undefined) data.callbackStart = callbackStart ? new Date(callbackStart) : null;
    if (callbackEnd !== undefined) data.callbackEnd = callbackEnd ? new Date(callbackEnd) : null;
    if (slaDueAt !== undefined) data.slaDueAt = slaDueAt ? new Date(slaDueAt) : null;
    if (parsed.data.assigneeId !== undefined) {
      data.assignee = parsed.data.assigneeId ? { connect: { id: parsed.data.assigneeId } } : { disconnect: true };
      delete (data as { assigneeId?: unknown }).assigneeId;
    }
    if (parsed.data.status === "RESOLVED" || parsed.data.status === "CLOSED") data.resolvedAt = new Date();
    const ticket = await prisma.ticket.update({ where: { id: existing.id }, data, include: ticketInclude });
    await audit(request, "ticket.update", "ticket", ticket.id, parsed.data);
    response.json(ticket);
  } catch (error) {
    next(error);
  }
});

const noteSchema = z.object({ text: z.string().min(1).max(4000) });

adminRouter.post("/tickets/:id/notes", requireRole("AGENT"), async (request, response, next) => {
  const parsed = noteSchema.safeParse(request.body);
  if (!parsed.success) return void bad(response, parsed.error);
  try {
    const note = await prisma.ticketNote.create({
      data: { ticketId: String(request.params.id), authorId: request.user!.id, text: parsed.data.text },
      include: { author: { select: { id: true, name: true } } }
    });
    await audit(request, "ticket.note", "ticket", String(request.params.id));
    response.status(201).json(note);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Users + audit (admin only)
// ---------------------------------------------------------------------------

adminRouter.get("/users", requireRole("ADMIN"), async (_request, response, next) => {
  try {
    response.json(
      await prisma.user.findMany({
        orderBy: { createdAt: "asc" },
        select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true }
      })
    );
  } catch (error) {
    next(error);
  }
});

const userCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  role: z.enum(["ADMIN", "SUPERVISOR", "AGENT", "VIEWER"])
});

adminRouter.post("/users", requireRole("ADMIN"), async (request, response, next) => {
  const parsed = userCreateSchema.safeParse(request.body);
  if (!parsed.success) return void bad(response, parsed.error);
  try {
    const user = await prisma.user.create({
      data: { ...parsed.data, email: parsed.data.email.toLowerCase() },
      select: { id: true, email: true, name: true, role: true, active: true }
    });
    await audit(request, "user.create", "user", user.id, { role: user.role });
    response.status(201).json(user);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      response.status(409).json({ error: "A user with that email already exists" });
      return;
    }
    next(error);
  }
});

const userPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.enum(["ADMIN", "SUPERVISOR", "AGENT", "VIEWER"]).optional(),
  active: z.boolean().optional()
});

adminRouter.patch("/users/:id", requireRole("ADMIN"), async (request, response, next) => {
  const parsed = userPatchSchema.safeParse(request.body);
  if (!parsed.success) return void bad(response, parsed.error);
  try {
    if (String(request.params.id) === request.user!.id && (parsed.data.active === false || (parsed.data.role && parsed.data.role !== "ADMIN"))) {
      response.status(400).json({ error: "You cannot remove your own admin access" });
      return;
    }
    const user = await prisma.user.update({
      where: { id: String(request.params.id) },
      data: parsed.data,
      select: { id: true, email: true, name: true, role: true, active: true }
    });
    if (parsed.data.active === false) await prisma.session.deleteMany({ where: { userId: user.id } });
    await audit(request, "user.update", "user", user.id, parsed.data);
    response.json(user);
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/audit", requireRole("ADMIN"), async (request, response, next) => {
  try {
    const { page, pageSize, skip, take } = pageOf(request.query as Record<string, unknown>);
    const [total, items] = await Promise.all([
      prisma.auditLog.count(),
      prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { user: { select: { id: true, name: true, email: true } } }
      })
    ]);
    response.json({ items, page, pageSize, total });
  } catch (error) {
    next(error);
  }
});
