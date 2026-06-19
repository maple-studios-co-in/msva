import dotenv from "dotenv";
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import type { DemoCall, TelephonyCall } from "@msva/shared";
import { exomlForStream, type ExotelInboundEvent } from "./exotel.js";
import { createCallPipeline, type CallPipeline } from "./pipeline.js";
import {
  createBrowserPipeline,
  type BrowserCallPipeline,
  type BrowserClientMessage
} from "./browserPipeline.js";

dotenv.config();

const port = Number(process.env.TELEPHONY_PORT ?? 4200);
const publicHost = process.env.PUBLIC_WS_HOST ?? `127.0.0.1:${port}`;
const publicWsUrl = `${process.env.PUBLIC_WS_SCHEME ?? "ws"}://${publicHost}/voice`;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "msva-telephony", publicWsUrl });
});

// Exotel calls this URL on inbound. Returning ExoML tells the carrier to
// open a WebSocket to /voice and forward call audio over it.
app.post("/exotel/incoming", (request, response) => {
  const callSid = String(request.body.CallSid ?? `sim-${Date.now()}`);
  const from = String(request.body.From ?? "+910000000000");
  const to = String(request.body.To ?? "+919000000000");
  console.log(`[exotel] incoming ${callSid} from=${from} to=${to}`);

  response.set("Content-Type", "application/xml");
  response.send(
    exomlForStream(
      `${publicWsUrl}?call=${encodeURIComponent(callSid)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      "Namaste, Madhu Sudhan support. Ek pal." // sub-second greeting before WS connects
    )
  );
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const { url } = request;
  if (!url || !(url.startsWith("/voice") || url.startsWith("/browser"))) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws, request) => {
  const url = new URL(request.url ?? "/voice", `http://${request.headers.host}`);

  // -------------------------------------------------------------------------
  // Browser call transport (/browser). The web app's "Live Call" screen
  // connects here, streaming 16 kHz PCM both ways.
  // -------------------------------------------------------------------------
  if (url.pathname.startsWith("/browser")) {
    const callId = url.searchParams.get("call") ?? "call-dist-ghee-delay";
    const fromNumber = url.searchParams.get("from") ?? "+910000000000";
    const profile: DemoCall = {
      id: callId,
      callerName: "Live demo caller",
      phone: fromNumber.replace(/[^0-9]/g, ""),
      callerType: "unknown",
      intent: "unknown",
      language: "hinglish",
      urgency: "medium",
      transcriptSeed: "In-browser live call.",
      expectedOutcome: "ticket_created"
    };
    console.log(`[browser] connection for ${callId}`);
    let pipeline: BrowserCallPipeline | null = createBrowserPipeline(ws, profile, callId);

    ws.on("message", (raw, isBinary) => {
      if (!pipeline) return;
      if (isBinary) {
        void pipeline.handleAudio(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
        return;
      }
      try {
        pipeline.handleText(JSON.parse(raw.toString()) as BrowserClientMessage);
      } catch (error) {
        console.error("[browser] text parse error", error);
      }
    });
    ws.on("close", async () => {
      console.log(`[browser] close for ${callId}`);
      await pipeline?.close();
      pipeline = null;
    });
    ws.on("error", (error) => console.error("[browser] ws error", error));
    return;
  }

  const callSid = url.searchParams.get("call") ?? `sim-${Date.now()}`;
  const fromNumber = url.searchParams.get("from") ?? "+910000000000";
  const toNumber = url.searchParams.get("to") ?? "+919000000000";

  const call: TelephonyCall = {
    callSid,
    provider: "exotel",
    fromNumber,
    toNumber,
    startedAt: new Date().toISOString(),
    // For the skeleton we reuse the first demo call profile as a fallback.
    // Production: look up the caller in the CRM by `fromNumber`.
    profile: {
      id: callSid,
      callerName: "Unknown caller",
      phone: fromNumber.replace(/[^0-9]/g, ""),
      callerType: "unknown",
      intent: "unknown",
      language: "hinglish",
      urgency: "medium",
      transcriptSeed: "Inbound call, no prior context.",
      expectedOutcome: "ticket_created"
    }
  };

  console.log(`[ws] connection for ${callSid}`);
  let pipeline: CallPipeline | null = createCallPipeline(ws, call);

  ws.on("message", async (raw) => {
    if (!pipeline) return;
    try {
      const event = JSON.parse(raw.toString()) as ExotelInboundEvent;
      await pipeline.handleInbound(event);
    } catch (error) {
      console.error("[ws] inbound parse error", error);
    }
  });

  ws.on("close", async () => {
    console.log(`[ws] close for ${callSid}`);
    await pipeline?.close();
    pipeline = null;
  });

  ws.on("error", (error) => console.error("[ws] error", error));
});

server.listen(port, () => {
  console.log(`MSVA telephony service listening on http://localhost:${port}`);
  console.log(`  Exotel webhook: POST /exotel/incoming`);
  console.log(`  Media stream:   ${publicWsUrl}`);
  console.log(`  Browser call:   ws://localhost:${port}/browser`);
});
