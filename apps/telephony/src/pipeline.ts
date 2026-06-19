import type {
  ChatStreamEvent,
  ConversationState,
  TelephonyCall,
  ToolResult
} from "@msva/shared";
import type { WebSocket } from "ws";
import { streamAgent } from "./agentClient.js";
import type { StreamingAsr } from "./asr/index.js";
import { createSarvamAsr } from "./asr/sarvam.js";
import { clearFrame, mediaFrame, type ExotelInboundEvent } from "./exotel.js";
import type { StreamingTts } from "./tts/index.js";
import { createSarvamTts } from "./tts/sarvam.js";
import { createEndpointer, type Endpointer } from "./vad.js";

// ---------------------------------------------------------------------------
// Per-call pipeline
//
// One CallPipeline is created per active call. It owns:
//   • the ASR session (PCM → text)
//   • the endpointer (when has the caller stopped speaking?)
//   • the TTS session (text → PCM, streamed back to Exotel)
//   • the conversation state (kept in-memory; in production persist this)
//   • a tool-result handler for telephony-side actions (warm transfer)
//
// The main loop:
//   1. media frames arrive → push PCM into ASR and the endpointer
//   2. endpointer fires → ASR.endpoint() → wait for `final` event
//   3. send final transcript to the agent over SSE
//   4. forward `token` events into TTS; forward TTS chunks back as media
//   5. handle `tool_result` events that telephony needs to act on (transfer)
//
// Barge-in: if the endpointer reports voiced audio while the bot is still
// speaking, cancel TTS, send a `clear` frame to Exotel, and start a fresh
// ASR utterance.
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 8000;
const LANGUAGE = process.env.AGENT_LANGUAGE ?? "hi-IN";
const TTS_VOICE = process.env.TTS_VOICE ?? "neha"; // bulbul:v3 — see .env.example for the full roster

export type CallPipeline = {
  call: TelephonyCall;
  handleInbound(event: ExotelInboundEvent): Promise<void>;
  close(): Promise<void>;
};

export function createCallPipeline(ws: WebSocket, call: TelephonyCall): CallPipeline {
  let streamSid = "";
  let conversation: ConversationState | undefined;
  let asr: StreamingAsr | null = null;
  let endpointer: Endpointer | null = null;
  let tts: StreamingTts | null = null;
  let botSpeaking = false;
  let turnInFlight = false;

  const sendOut = (payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  const startAsr = () => {
    asr?.close().catch(() => undefined);
    asr = createSarvamAsr({ language: LANGUAGE, sampleRate: SAMPLE_RATE });
    endpointer = createEndpointer({ sampleRate: SAMPLE_RATE });

    // Consume ASR finals in the background; trigger a turn when one arrives.
    (async () => {
      for await (const event of asr!.events()) {
        if (event.type === "final" && event.text.trim()) {
          void runTurn(event.text);
        }
      }
    })().catch((error) => console.error("asr loop error", error));
  };

  const interruptBot = () => {
    if (!botSpeaking) return;
    tts?.cancel();
    tts = null;
    botSpeaking = false;
    if (streamSid) sendOut(clearFrame(streamSid));
  };

  const runTurn = async (utterance: string) => {
    if (turnInFlight) return; // simple lock; production uses a real queue.
    turnInFlight = true;
    try {
      tts = createSarvamTts({ voice: TTS_VOICE, language: LANGUAGE, sampleRate: SAMPLE_RATE });
      botSpeaking = true;

      // Pump TTS chunks back to Exotel as soon as they're produced.
      const playback = (async () => {
        for await (const chunk of tts!.chunks()) {
          if (!streamSid) continue;
          if (chunk.pcm.byteLength > 0) sendOut(mediaFrame(streamSid, chunk.pcm));
          if (chunk.isFinal) break;
        }
      })();

      for await (const event of streamAgent(call.callSid, utterance, conversation)) {
        handleAgentEvent(event);
      }
      tts?.end();
      await playback;
    } catch (error) {
      console.error("turn error", error);
    } finally {
      botSpeaking = false;
      turnInFlight = false;
    }
  };

  const handleAgentEvent = (event: ChatStreamEvent) => {
    switch (event.type) {
      case "token":
        tts?.push(event.text);
        break;
      case "tool_result":
        handleToolResult(event.result);
        break;
      case "final":
        conversation = event.state;
        break;
      case "error":
        console.error("agent error", event.message);
        break;
    }
  };

  const handleToolResult = (result: ToolResult) => {
    if (!result.ok) return;
    if (result.name === "transfer_to_human") {
      // Real impl: emit an out-of-band signal to the dialer to <Dial> the
      // human queue, optionally with a whisper introduction.
      console.log(`[telephony] would warm-transfer call ${call.callSid}`, result.data);
    }
  };

  return {
    call,
    async handleInbound(event) {
      switch (event.event) {
        case "connected":
          // No-op; "start" gives us the streamSid.
          break;
        case "start":
          streamSid = event.stream_sid;
          startAsr();
          // Kick off the greeting as if the caller said something benign.
          void runTurn("[call-started]");
          break;
        case "media": {
          if (!asr || !endpointer) return;
          const pcm = Buffer.from(event.media.payload, "base64");
          endpointer.feed(pcm);
          await asr.feed(pcm);
          if (botSpeaking && endpointer.voicedMs() > 200) {
            // Caller is talking over the bot — interrupt.
            interruptBot();
          }
          if (endpointer.endpointed()) {
            endpointer.reset();
            await asr.endpoint();
          }
          break;
        }
        case "stop":
          await this.close();
          break;
        case "mark":
          // Could be used to mark TTS chunks for latency tracking.
          break;
      }
    },
    async close() {
      tts?.cancel();
      await asr?.close().catch(() => undefined);
      asr = null;
      endpointer = null;
      tts = null;
    }
  };
}
