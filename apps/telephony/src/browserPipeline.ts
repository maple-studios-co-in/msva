import type {
  ChatStreamEvent,
  ConversationState,
  DemoCall,
  ToolResult
} from "@msva/shared";
import type { WebSocket } from "ws";
import { streamAgent } from "./agentClient.js";
import { createSarvamAsr } from "./asr/sarvam.js";
import type { StreamingAsr } from "./asr/index.js";
import { createSarvamTts } from "./tts/sarvam.js";
import type { StreamingTts } from "./tts/index.js";
import { createEndpointer, type Endpointer } from "./vad.js";

// ---------------------------------------------------------------------------
// Browser-call pipeline
//
// This is the in-browser sibling of the Exotel pipeline. The browser is just
// another telephony transport: it captures the mic, downsamples to 16 kHz
// 16-bit mono PCM, and streams it over a WebSocket. We run the exact same
// brain (Sarvam ASR → agent SSE → Sarvam TTS) and stream PCM back for the
// browser to play. Barge-in, endpointing, and tool handling mirror the phone
// path — the only difference is the wire framing (raw binary + small JSON
// control messages instead of Exotel's base64-in-JSON media events).
//
// Wire protocol
//   Client → Server
//     JSON  { type: "start", callId, from?, voice?, language? }
//     bin   Int16 PCM mono @ 16 kHz  (mic audio)
//     JSON  { type: "stop" }
//   Server → Client
//     JSON  { type: "ready" }
//     JSON  { type: "status", state: "listening" | "thinking" | "speaking" }
//     JSON  { type: "user_transcript", text, final }
//     JSON  { type: "agent_transcript", text, final }
//     JSON  { type: "clear" }                      (barge-in: flush playback)
//     JSON  { type: "outcome", outcome, collected, escalationReason? }
//     bin   Int16 PCM mono @ 16 kHz  (TTS audio)
// ---------------------------------------------------------------------------

const SAMPLE_RATE = Number(process.env.BROWSER_SAMPLE_RATE ?? 16000);
const LANGUAGE = process.env.AGENT_LANGUAGE ?? "hi-IN";
const DEFAULT_VOICE = process.env.TTS_VOICE ?? "neha";

// VAD tuning for browser mic input (echo-cancelled, higher SR than phone).
const VAD_SILENCE_MS = Number(process.env.BROWSER_VAD_SILENCE_MS ?? 750);
const VAD_ENERGY_FLOOR = Number(process.env.BROWSER_VAD_ENERGY_FLOOR ?? 550);
const VAD_MIN_VOICED_MS = Number(process.env.BROWSER_VAD_MIN_VOICED_MS ?? 280);
const BARGE_IN_MS = Number(process.env.BROWSER_BARGE_IN_MS ?? 420);

export type BrowserStartMessage = {
  type: "start";
  callId?: string;
  from?: string;
  voice?: string;
  language?: string;
};

export type BrowserClientMessage = BrowserStartMessage | { type: "stop" };

export type BrowserCallPipeline = {
  handleText(message: BrowserClientMessage): void;
  handleAudio(pcm: Buffer): Promise<void>;
  close(): Promise<void>;
};

export function createBrowserPipeline(
  ws: WebSocket,
  profile: DemoCall,
  callId: string
): BrowserCallPipeline {
  let voice = DEFAULT_VOICE;
  let language = LANGUAGE;
  let conversation: ConversationState | undefined;
  let asr: StreamingAsr | null = null;
  let endpointer: Endpointer | null = null;
  let tts: StreamingTts | null = null;
  let botSpeaking = false;
  let turnInFlight = false;
  let started = false;
  // Latency instrumentation.
  let lastEndpointAt: number | null = null;
  let turnIndex = 0;
  let turnInterrupted = false;

  const sendJson = (payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };
  const sendAudio = (pcm: Buffer) => {
    if (pcm.byteLength > 0 && ws.readyState === ws.OPEN) ws.send(pcm);
  };

  const startAsr = () => {
    asr?.close().catch(() => undefined);
    asr = createSarvamAsr({ language, sampleRate: SAMPLE_RATE });
    endpointer = createEndpointer({
      sampleRate: SAMPLE_RATE,
      silenceMs: VAD_SILENCE_MS,
      energyFloor: VAD_ENERGY_FLOOR,
      minVoicedMs: VAD_MIN_VOICED_MS
    });

    (async () => {
      for await (const event of asr!.events()) {
        if (event.type === "final" && event.text.trim()) {
          sendJson({ type: "user_transcript", text: event.text, final: true });
          void runTurn(event.text);
        }
      }
    })().catch((error) => console.error("[browser] asr loop error", error));
  };

  const interruptBot = () => {
    if (!botSpeaking) return;
    turnInterrupted = true;
    tts?.cancel();
    tts = null;
    botSpeaking = false;
    sendJson({ type: "clear" });
    sendJson({ type: "status", state: "listening" });
  };

  const runTurn = async (utterance: string) => {
    if (turnInFlight) return;
    turnInFlight = true;
    turnInterrupted = false;
    const index = ++turnIndex;
    const turnStart = Date.now();
    const endpointAt = lastEndpointAt; // when the caller stopped talking
    lastEndpointAt = null;
    let firstTokenAt: number | null = null;
    let firstAudioAt: number | null = null;
    let finalAt: number | null = null;
    let reply = "";
    try {
      sendJson({ type: "status", state: "thinking" });
      tts = createSarvamTts({ voice, language, sampleRate: SAMPLE_RATE });
      botSpeaking = true;

      const playback = (async () => {
        let announced = false;
        for await (const chunk of tts!.chunks()) {
          if (chunk.pcm.byteLength > 0) {
            if (!announced) {
              announced = true;
              firstAudioAt = Date.now();
              sendJson({ type: "status", state: "speaking" });
            }
            sendAudio(chunk.pcm);
          }
          if (chunk.isFinal) break;
        }
      })();

      for await (const event of streamAgent(callId, utterance, conversation)) {
        if (event.type === "token" && firstTokenAt === null) firstTokenAt = Date.now();
        if (event.type === "final") finalAt = Date.now();
        reply = handleAgentEvent(event, reply);
      }
      tts?.end();
      await playback;
      sendJson({ type: "agent_transcript", text: reply, final: true });
    } catch (error) {
      console.error("[browser] turn error", error);
    } finally {
      botSpeaking = false;
      turnInFlight = false;
      const since = (at: number | null) => (at === null ? null : at - turnStart);
      sendJson({
        type: "metrics",
        metrics: {
          turnIndex: index,
          asrMs: endpointAt === null ? null : turnStart - endpointAt,
          llmFirstTokenMs: since(firstTokenAt),
          llmTotalMs: since(finalAt),
          ttsFirstByteMs: since(firstAudioAt),
          ttfwMs: endpointAt === null || firstAudioAt === null ? null : firstAudioAt - endpointAt,
          interrupted: turnInterrupted
        }
      });
      sendJson({ type: "status", state: "listening" });
    }
  };

  const handleAgentEvent = (event: ChatStreamEvent, reply: string): string => {
    switch (event.type) {
      case "token":
        tts?.push(event.text);
        reply += event.text;
        sendJson({ type: "agent_transcript", text: reply, final: false });
        return reply;
      case "tool_result":
        handleToolResult(event.result);
        return reply;
      case "final":
        conversation = event.state;
        sendJson({
          type: "outcome",
          outcome: event.state.outcome,
          collected: event.state.collected,
          escalationReason: event.state.escalationReason ?? null
        });
        return reply;
      case "error":
        console.error("[browser] agent error", event.message);
        return reply;
      default:
        return reply;
    }
  };

  const handleToolResult = (result: ToolResult) => {
    if (!result.ok) return;
    if (result.name === "transfer_to_human") {
      console.log(`[browser] would warm-transfer call ${callId}`, result.data);
    }
  };

  return {
    handleText(message) {
      if (message.type === "start") {
        if (started) return;
        started = true;
        if (message.voice) voice = message.voice;
        if (message.language) language = message.language;
        sendJson({ type: "ready" });
        startAsr();
        // Greet the caller exactly as the phone path does.
        void runTurn("[call-started]");
      } else if (message.type === "stop") {
        void this.close();
      }
    },
    async handleAudio(pcm) {
      if (!asr || !endpointer) return;
      endpointer.feed(pcm);
      // Caller talking over the bot → barge-in.
      if (botSpeaking) {
        if (endpointer.voicedMs() > BARGE_IN_MS) interruptBot();
        return; // don't transcribe bot echo into the next utterance
      }
      await asr.feed(pcm);
      if (endpointer.endpointed()) {
        endpointer.reset();
        lastEndpointAt = Date.now(); // caller just stopped talking
        await asr.endpoint();
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
