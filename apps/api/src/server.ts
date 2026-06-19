import "./env.js"; // must be first — loads .env before any env-reading module
import cors from "cors";
import express from "express";
import path from "node:path";
import { z } from "zod";
import { buildAnalytics, loadCallRecords } from "./analytics.js";
import { demoCalls, findDemoCall } from "./demoCalls.js";
import { BULBUL_V3_VOICES, previewVoice } from "./sarvamPreview.js";
import { getLlmEnabled, handleChat, initialState, setLlmEnabled, streamChat } from "./voiceAgent.js";
import { DEMO_FAILSAFE_AUDIO_PATH, demoFailsafeAvailable, loadDemoFailsafe } from "./demoFailsafe.js";

const app = express();
const port = Number(process.env.PORT ?? 4100);
const csvPath = process.env.CSV_PATH ?? "../../data/reports.csv";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

let records = loadCallRecords(path.resolve(process.cwd(), csvPath));

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    service: "msva-api",
    model: process.env.OLLAMA_MODEL ?? "qwen3.5:4b",
    records: records.length
  });
});

app.get("/api/analytics", (_request, response) => {
  response.json(buildAnalytics(records));
});

app.post("/api/analytics/reload", (_request, response) => {
  records = loadCallRecords(path.resolve(process.cwd(), csvPath));
  response.json({ ok: true, records: records.length });
});

app.get("/api/demo-calls", (_request, response) => {
  response.json(demoCalls);
});

app.get("/api/demo-calls/:id/state", (request, response) => {
  response.json(initialState(findDemoCall(request.params.id)));
});

const chatSchema = z.object({
  callId: z.string(),
  message: z.string().min(1),
  state: z.any().optional()
});

app.post("/api/voice-agent/chat", async (request, response) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  const result = await handleChat(parsed.data.callId, parsed.data.message, parsed.data.state);
  response.json(result);
});

// Server-Sent Events stream of ChatStreamEvent. The browser demo can switch
// to this endpoint to get token-by-token replies; the telephony service
// consumes the underlying `streamChat` generator directly (no HTTP hop).
app.post("/api/voice-agent/chat/stream", async (request, response) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();

  try {
    for await (const event of streamChat(parsed.data.callId, parsed.data.message, parsed.data.state)) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (error) {
    response.write(
      `data: ${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "stream error" })}\n\n`
    );
  } finally {
    response.end();
  }
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

app.post("/api/voice-agent/tts-preview", async (request, response) => {
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
// at runtime, so a presenter can switch from the app without SSH. In-memory:
// resets to the AGENT_LLM env default on restart.
// ---------------------------------------------------------------------------

app.get("/api/voice-agent/llm-mode", (_request, response) => {
  response.json({ enabled: getLlmEnabled(), model: process.env.OLLAMA_MODEL ?? "qwen3.5:4b" });
});

const llmModeSchema = z.object({ enabled: z.boolean() });

app.post("/api/voice-agent/llm-mode", (request, response) => {
  const parsed = llmModeSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  setLlmEnabled(parsed.data.enabled);
  response.json({ enabled: getLlmEnabled(), model: process.env.OLLAMA_MODEL ?? "qwen3.5:4b" });
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

app.listen(port, () => {
  console.log(`MSVA API running on http://localhost:${port}`);
});
