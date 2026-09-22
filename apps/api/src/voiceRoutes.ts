import express from "express";
import { WorkerEventSchema, VoiceLeaseClaimSchema, VoiceLeaseRenewSchema, VoiceToolSchema } from "@msva/contracts";
import { Prisma } from "@msva/db";
import { claimVoiceLease, invokeVoiceTool, recordVoiceEvent, renewVoiceLease, VoiceError, voiceContext, voiceToolReceipt } from "./voiceService.js";

const bearer = (request: express.Request) => request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7).trim() : "";
function fail(response: express.Response, error: unknown) {
  if (error instanceof VoiceError) return response.status(error.status).json({ error: error.code });
  // Its kind only: messages can quote query arguments, including transcript text.
  console.error("[voice] request failed", error instanceof Prisma.PrismaClientKnownRequestError ? error.code : error instanceof Error ? error.name : "unknown");
  return response.status(503).json({ error: "VOICE_UNAVAILABLE" });
}

export const voiceRouter = express.Router();
voiceRouter.use((request, response, next) => {
  if (process.env.VOICE_ENABLED !== "true" || !process.env.VOICE_WORKER_API_TOKEN || !process.env.VOICE_LEASE_SIGNING_KEY) return response.status(503).json({ error: "VOICE_DISABLED" });
  next();
});
voiceRouter.post("/leases/claim", async (request, response) => {
  const parsed = VoiceLeaseClaimSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: "INVALID_REQUEST" });
  try { return response.json(await claimVoiceLease(parsed.data, request.headers.authorization)); } catch (error) { return fail(response, error); }
});
voiceRouter.get("/calls/:id/context", async (request, response) => {
  try { return response.json(await voiceContext(String(request.params.id), bearer(request))); } catch (error) { return fail(response, error); }
});
voiceRouter.post("/calls/:id/lease/renew", async (request, response) => {
  const parsed = VoiceLeaseRenewSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: "INVALID_REQUEST" });
  try { return response.json(await renewVoiceLease(String(request.params.id), parsed.data.agentEpoch, bearer(request))); } catch (error) { return fail(response, error); }
});
voiceRouter.post("/calls/:id/events", async (request, response) => {
  const parsed = WorkerEventSchema.safeParse(request.body); if (!parsed.success || parsed.data.callId !== String(request.params.id)) return response.status(400).json({ error: "INVALID_REQUEST" });
  try { return response.json(await recordVoiceEvent(parsed.data, bearer(request))); } catch (error) { return fail(response, error); }
});
voiceRouter.post("/calls/:id/tools", async (request, response) => {
  const parsed = VoiceToolSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: "INVALID_REQUEST" });
  try { return response.json(await invokeVoiceTool({ callId: String(request.params.id), ...parsed.data }, bearer(request))); } catch (error) { return fail(response, error); }
});
voiceRouter.get("/calls/:id/tools/:invocationId", async (request, response) => {
  try { return response.json(await voiceToolReceipt(String(request.params.id), String(request.params.invocationId), bearer(request))); } catch (error) { return fail(response, error); }
});
