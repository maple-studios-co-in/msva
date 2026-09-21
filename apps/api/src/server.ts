import "./env.js"; // must be first — loads .env before any env-reading module
import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createSampleAnalytics } from "./sampleAnalytics.js";
import { demoCalls, findDemoCall } from "./demoCalls.js";
import { BULBUL_V3_VOICES, previewVoice } from "./sarvamPreview.js";
import { getActiveModel, getLlmEnabled, handleChat, initialState, setLlmEnabled } from "./voiceAgent.js";
import { DEMO_FAILSAFE_AUDIO_PATH, demoFailsafeAvailable, loadDemoFailsafe } from "./demoFailsafe.js";
import { databaseReady } from "@msva/db";
import { authenticate, requireRole } from "./auth.js";
import { adminRouter } from "./routes/admin.js";
import { internalRouter } from "./routes/internal.js";
import { internalAgentRouter } from "./routes/internalAgent.js";
import { createLiveCallsHandler } from "./liveCalls.js";
import { startAssessmentWorker } from "./assessmentWorker.js";

const port = Number(process.env.PORT ?? 4100);
const csvPath = process.env.CSV_PATH ?? "../../data/reports.csv";

export function createApp(): express.Express {
const app = express();

// The console sends its session cookie, so CORS must name the origin rather
// than use "*". Same-origin deployments (Caddy) never hit this path.
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",").map((o) => o.trim()) ?? true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", true);

const sampleAnalytics = createSampleAnalytics(path.resolve(process.cwd(), csvPath));

app.get("/health", async (_request, response) => {
  response.json({
    ok: true,
    service: "msva-api",
    model: getActiveModel(),
    records: sampleAnalytics.recordCount,
    sampleAnalytics: sampleAnalytics.status,
    database: await databaseReady()
  });
});

// This service-authenticated provider route must precede the legacy internal
// router, whose development fallback is intentionally not valid for SSE.
app.use("/api/internal/agent", internalAgentRouter);
app.use("/api/internal", internalRouter);
app.use("/api/admin", adminRouter);
app.get("/api/live-calls", createLiveCallsHandler());

app.use("/api/analytics", sampleAnalytics.router);

app.get("/api/demo-calls", (_request, response) => {
  response.json(demoCalls);
});

app.get("/api/demo-calls/:id/state", (request, response) => {
  response.json(initialState(findDemoCall(request.params.id)));
});

const chatSchema = z.object({
  callId: z.string(),
  message: z.string().min(1),
  state: z.any().optional(),
  sessionId: z.string().optional()
});

// The demo's chat and voice preview spend provider credits, so they need an agent's
// console sign-in (the session cookie the console sets on this origin).
app.post("/api/voice-agent/chat", authenticate, requireRole("AGENT"), async (request, response) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const result = await handleChat(parsed.data.callId, parsed.data.message, parsed.data.state, parsed.data.sessionId);
  response.json(result);
});

// ---------------------------------------------------------------------------
// Voice playground — dashboard preview of Sarvam TTS voices.
// GET  /api/voice-agent/voices         → list of voices, grouped by gender
// POST /api/voice-agent/tts-preview    → { voice, text, language? } → audio
//
// The browser never sees the Sarvam key; the api fetches the audio and
// returns it as a base64 WAV the UI can drop straight into an <audio> tag.
// ---------------------------------------------------------------------------

app.get("/api/voice-agent/voices", (_request, response) => {
  response.json({
    model: process.env.SARVAM_TTS_MODEL ?? "bulbul:v3",
    keyConfigured: Boolean(process.env.SARVAM_API_KEY),
    voices: BULBUL_V3_VOICES
  });
});

const previewSchema = z.object({
  voice: z.string().min(1),
  text: z.string().min(1).max(2500),
  language: z.string().optional()
});

app.post("/api/voice-agent/tts-preview", authenticate, requireRole("AGENT"), async (request, response) => {
  const parsed = previewSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const result = await previewVoice(parsed.data);
  if (!result.ok) {
    response.status(result.error.status).json({ error: result.error });
    return;
  }
  response.json(result.data);
});

// ---------------------------------------------------------------------------
// AI brain mode — flip between the real LLM and instant deterministic replies
// at runtime, so a supervisor can switch from the app without SSH. It changes how
// every call is answered, live ones included, so switching needs a supervisor's
// sign-in. In-memory: resets to the AGENT_LLM env default on restart.
// ---------------------------------------------------------------------------

app.get("/api/voice-agent/llm-mode", (_request, response) => {
  response.json({ enabled: getLlmEnabled(), model: getActiveModel() });
});

const llmModeSchema = z.object({ enabled: z.boolean() });

app.post("/api/voice-agent/llm-mode", authenticate, requireRole("SUPERVISOR"), (request, response) => {
  const parsed = llmModeSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  setLlmEnabled(parsed.data.enabled);
  response.json({ enabled: getLlmEnabled(), model: getActiveModel() });
});

// ---------------------------------------------------------------------------
// Demo failsafe — a pre-recorded agent clip served first-party so a presenter
// can fall back to it if the live pipeline misbehaves mid-demo.
// ---------------------------------------------------------------------------

app.get("/api/voice-agent/demo-failsafe", (_request, response) => {
  const config = loadDemoFailsafe();
  if (!config || !demoFailsafeAvailable()) {
    response.json({ available: false });
    return;
  }
  response.json({
    available: true,
    callerName: config.callerName,
    voice: config.voice,
    transcript: config.transcript,
    outcome: config.outcome,
    collected: config.collected,
    syntheticMetrics: config.syntheticMetrics,
    audioUrl: "/api/voice-agent/demo-failsafe/audio"
  });
});

app.get("/api/voice-agent/demo-failsafe/audio", (_request, response) => {
  if (!demoFailsafeAvailable()) {
    response.status(404).json({ error: "No failsafe clip configured" });
    return;
  }
  response.sendFile(DEMO_FAILSAFE_AUDIO_PATH, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-cache" }
  });
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createApp().listen(port, () => {
    console.log(`MSVA API running on http://localhost:${port}`);
  });
  const assessmentWorker = startAssessmentWorker();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void assessmentWorker.stop().finally(() => server.close());
    });
  }
}
