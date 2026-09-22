import express from "express";
import { z } from "zod";
import type { ConversationState } from "@msva/shared";
import { streamChat } from "../voiceAgent.js";

const envelopeSchema = z.object({
  callId: z.string().min(6).max(128),
  message: z.string().min(1).max(4_000),
  state: z.custom<ConversationState>().optional(),
  sessionId: z.string().min(6).max(128),
  transport: z.enum(["EXOTEL", "BROWSER"]),
  browserConnectionId: z.string().min(16).max(128).optional()
}).strict().superRefine((value, context) => {
  if (value.transport === "BROWSER" && !value.browserConnectionId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "browserConnectionId is required for browser transport" });
  }
  if (value.transport === "EXOTEL" && value.browserConnectionId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "browserConnectionId is not allowed for Exotel transport" });
  }
});

/**
 * Service-only SSE entrypoint. This router is deliberately kept separate from
 * the legacy internal router, whose development fallback is not appropriate
 * for provider-spend endpoints. Mount it before `/api/internal`.
 */
export const internalAgentRouter = express.Router();

internalAgentRouter.use((request, response, next) => {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    response.status(503).json({ error: "Internal agent service is unavailable" });
    return;
  }
  if (request.get("x-internal-token") !== token) {
    response.status(401).json({ error: "Bad internal token" });
    return;
  }
  next();
});

internalAgentRouter.post("/chat/stream", async (request, response) => {
  const parsed = envelopeSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid internal agent request" });
    return;
  }

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();

  try {
    for await (const event of streamChat(
      parsed.data.callId,
      parsed.data.message,
      parsed.data.state,
      parsed.data.sessionId
    )) {
      if (response.writableEnded || response.destroyed) break;
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch {
    if (!response.writableEnded && !response.destroyed) {
      response.write('data: {"type":"error","message":"stream error"}\n\n');
    }
  } finally {
    if (!response.writableEnded) response.end();
  }
});
