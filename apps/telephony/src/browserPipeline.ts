import type {
  ChatStreamEvent,
  ConversationState,
  DemoCall,
  ToolResult
} from "@msva/shared";
import { randomUUID } from "node:crypto";
import { CALL_GREETING, ASR_RETRY } from "./prompts.js";
import { createBufferTts, lookupPrompt } from "./tts/promptCache.js";
import type { WebSocket } from "ws";
import { callLog } from "./callLog.js";
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
  let bargeInAudio = Buffer.alloc(0);
  let turnInFlight = false;
  let closed = false;
  const pendingUtterances: { text: string; endpointAt: number | null }[] = [];
  let retryPending = false;
  let retryAnnounced = false;
  let started = false;
  // Latency instrumentation.
  let lastEndpointAt: number | null = null;
  let turnIndex = 0;
  let turnInterrupted = false;
  // Persistence: one session id per browser call, reported to the API so the
  // call, its turns and any tickets land in the database. Browser calls are
  // demo traffic, so they are stored as test calls.
  const sessionId = randomUUID();
  let ended = false;
  let turnSource: string | null = null;
  let turnTools: string[] = [];

  const sendJson = (payload: unknown) => {
    if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };
  const sendAudio = (pcm: Buffer) => {
    if (!closed && pcm.byteLength > 0 && ws.readyState === ws.OPEN) ws.send(pcm);
  };

  const startAsr = () => {
    asr?.close().catch(() => undefined);
    asr = createSarvamAsr({ language, sampleRate: SAMPLE_RATE, energyFloor: VAD_ENERGY_FLOOR });
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
          if (pendingUtterances.length < 3) {
            retryAnnounced = false;
            retryPending = false;
            pendingUtterances.push({ text: event.text, endpointAt: lastEndpointAt });
          } else {
            console.warn("[browser] caller turn queue full; requesting repetition");
            queueRetry();
          }
          lastEndpointAt = null;
          void drainPending();
        } else if (event.type === "error") {
          console.warn(`[browser] recognition unavailable: ${event.code}`);
          queueRetry();
        }
      }
    })().catch((error) => console.error("[browser] asr loop error", error));
  };

  const queueRetry = () => {
    if (closed || retryAnnounced) return;
    retryAnnounced = true;
    retryPending = true;
    void drainPending();
  };

  const drainPending = async (): Promise<void> => {
    if (closed || turnInFlight) return;
    const utterance = pendingUtterances.shift();
    if (utterance) await runTurn(utterance.text, utterance.endpointAt);
    else if (retryPending) {
      retryPending = false;
      await speak(ASR_RETRY);
    }
  };

  const speak = async (text: string): Promise<void> => {
    if (closed || turnInFlight) return;
    turnInFlight = true;
    try {
      const cached = lookupPrompt(text, { voice, language, sampleRate: SAMPLE_RATE });
      const instance = cached
        ? createBufferTts(cached, { sampleRate: SAMPLE_RATE })
        : createSarvamTts({ voice, language, sampleRate: SAMPLE_RATE });
      tts = instance;
      botSpeaking = true;
      sendJson({ type: "status", state: "speaking" });
      sendJson({ type: "agent_transcript", text, final: true });
      instance.push(text);
      instance.end();
      let reported = false;
      for await (const chunk of instance.chunks()) {
        if (closed || tts !== instance) break;
        sendAudio(chunk.pcm);
        if (text === ASR_RETRY && chunk.pcm.byteLength > 0 && !reported) {
          reported = true;
          void callLog.turn(sessionId, { index: ++turnIndex, callerText: null, replyText: text, source: "asr_error", toolCalls: [] });
        }
        if (chunk.isFinal) break;
      }
    } catch (error) {
      console.error("[browser] prompt error", error);
    } finally {
      botSpeaking = false;
      bargeInAudio = Buffer.alloc(0);
      turnInFlight = false;
      tts = null;
      sendJson({ type: "status", state: "listening" });
      void drainPending();
    }
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

  const runTurn = async (utterance: string, endpointAt: number | null) => {
    if (closed || turnInFlight) return;
    turnInFlight = true;
    turnInterrupted = false;
    const index = ++turnIndex;
    const turnStart = Date.now();
    let firstTokenAt: number | null = null;
    let firstAudioAt: number | null = null;
    let finalAt: number | null = null;
    let reply = "";
    turnSource = null;
    turnTools = [];
    try {
      sendJson({ type: "status", state: "thinking" });
      const instance = createSarvamTts({ voice, language, sampleRate: SAMPLE_RATE });
      tts = instance;
      botSpeaking = true;

      const playback = (async () => {
        let announced = false;
        for await (const chunk of instance.chunks()) {
          if (closed || tts !== instance) break;
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

      for await (const event of streamAgent(callId, utterance, conversation, sessionId)) {
        if (closed) break;
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
      bargeInAudio = Buffer.alloc(0);
      turnInFlight = false;
      tts = null;
      const since = (at: number | null) => (at === null ? null : at - turnStart);
      const metrics = {
        turnIndex: index,
        asrMs: endpointAt === null ? null : turnStart - endpointAt,
        llmFirstTokenMs: since(firstTokenAt),
        llmTotalMs: since(finalAt),
        ttsFirstByteMs: since(firstAudioAt),
        ttfwMs: endpointAt === null || firstAudioAt === null ? null : firstAudioAt - endpointAt,
        interrupted: turnInterrupted
      };
      sendJson({ type: "metrics", metrics });
      sendJson({ type: "status", state: "listening" });
      void callLog.turn(sessionId, {
        index,
        callerText: utterance,
        replyText: reply,
        asrMs: metrics.asrMs,
        llmFirstTokenMs: metrics.llmFirstTokenMs,
        llmTotalMs: metrics.llmTotalMs,
        ttsFirstByteMs: metrics.ttsFirstByteMs,
        ttfwMs: metrics.ttfwMs,
        interrupted: metrics.interrupted,
        source: turnSource,
        toolCalls: turnTools,
        outcome: conversation?.outcome,
        collected: conversation?.collected,
        escalationReason: conversation?.escalationReason,
        intent: conversation?.call.intent
      });
      void drainPending();
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
        turnTools.push(event.result.name);
        handleToolResult(event.result);
        return reply;
      case "final":
        conversation = event.state;
        turnSource = event.source;
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
      if (closed) return;
      if (message.type === "start") {
        if (started) return;
        started = true;
        if (message.voice) voice = message.voice;
        if (message.language) language = message.language;
        sendJson({ type: "ready" });
        void callLog.start({
          id: sessionId,
          provider: "browser",
          fromNumber: profile.phone || "browser",
          callerName: profile.callerName,
          callerType: profile.callerType,
          isTest: true,
          language,
          metadata: { profileId: callId, voice }
        });
        startAsr();
        // Greet the caller exactly as the phone path does.
        void speak(CALL_GREETING);
      } else if (message.type === "stop") {
        void this.close();
      }
    },
    async handleAudio(pcm) {
      if (!asr || !endpointer) return;
      endpointer.feed(pcm);
      // Caller talking over the bot → barge-in.
      if (botSpeaking) {
        const retainBytes = Math.round(SAMPLE_RATE * 2 * (BARGE_IN_MS + 400) / 1000);
        bargeInAudio = Buffer.from(Buffer.concat([bargeInAudio, pcm]).subarray(-retainBytes));
        if (endpointer.voicedMs() <= BARGE_IN_MS) return;
        interruptBot();
        const interruptedAudio = bargeInAudio;
        bargeInAudio = Buffer.alloc(0);
        await asr.feed(interruptedAudio);
      } else {
        bargeInAudio = Buffer.alloc(0);
        await asr.feed(pcm);
      }
      if (endpointer.endpointed()) {
        endpointer.reset();
        lastEndpointAt = Date.now(); // caller just stopped talking
        await asr.endpoint();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      pendingUtterances.length = 0;
      bargeInAudio = Buffer.alloc(0);
      retryPending = false;
      tts?.cancel();
      await asr?.close().catch(() => undefined);
      asr = null;
      endpointer = null;
      tts = null;
      if (started && !ended) {
        ended = true;
        void callLog.end(sessionId, { outcome: conversation?.outcome });
      }
    }
  };
}
