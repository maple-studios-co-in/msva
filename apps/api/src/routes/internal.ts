import express from "express";
import { z } from "zod";
import { recordCallEnd, recordCallStart, recordTurn } from "../calls.js";

// ---------------------------------------------------------------------------
// Internal routes — called by the telephony service, never by browsers.
//
// Authenticated with a shared secret in `x-internal-token`. When the token is
// not configured (local development) requests are accepted with a one-time
// warning; in production a missing token refuses every call.
// ---------------------------------------------------------------------------

const token = process.env.INTERNAL_API_TOKEN;
let warned = false;

export const internalRouter = express.Router();

internalRouter.use((request, response, next) => {
  if (!token) {
    if (process.env.NODE_ENV === "production") {
      response.status(503).json({ error: "INTERNAL_API_TOKEN is not configured" });
      return;
    }
    if (!warned) {
      warned = true;
      console.warn("[internal] INTERNAL_API_TOKEN not set — accepting unauthenticated internal calls (dev only)");
    }
    return next();
  }
  if (request.headers["x-internal-token"] !== token) {
    response.status(401).json({ error: "Bad internal token" });
    return;
  }
  next();
});

const startSchema = z.object({
  id: z.string().min(6).max(128),
  provider: z.enum(["browser", "exotel", "twilio"]),
  providerSid: z.string().nullish(),
  fromNumber: z.string().min(1),
  toNumber: z.string().nullish(),
  callerName: z.string().nullish(),
  callerType: z.string().nullish(),
  isTest: z.boolean().optional(),
  agentSlug: z.string().nullish(),
  language: z.string().nullish(),
  metadata: z.record(z.unknown()).nullish()
});

internalRouter.post("/calls/start", async (request, response, next) => {
  const parsed = startSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    response.json(await recordCallStart(parsed.data));
  } catch (error) {
    next(error);
  }
});

const ms = z.number().int().nonnegative().nullish();
const turnSchema = z.object({
  index: z.number().int().nonnegative(),
  callerText: z.string().nullish(),
  replyText: z.string().nullish(),
  asrMs: ms,
  llmFirstTokenMs: ms,
  llmTotalMs: ms,
  ttsFirstByteMs: ms,
  ttfwMs: ms,
  interrupted: z.boolean().optional(),
  source: z.string().nullish(),
  toolCalls: z.unknown().optional(),
  outcome: z.string().nullish(),
  collected: z.record(z.string()).nullish(),
  escalationReason: z.string().nullish(),
  intent: z.string().nullish()
});

internalRouter.post("/calls/:id/turns", async (request, response, next) => {
  const parsed = turnSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    await recordTurn(String(request.params.id), parsed.data);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

const endSchema = z.object({
  status: z.string().nullish(),
  outcome: z.string().nullish()
});

internalRouter.post("/calls/:id/end", async (request, response, next) => {
  const parsed = endSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    await recordCallEnd(String(request.params.id), parsed.data);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
