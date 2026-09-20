import type {
  ChatStreamEvent,
  ConversationState,
  DemoCall,
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
import { createBufferTts, lookupPrompt } from "./tts/promptCache.js";
import { createEndpointer, type Endpointer } from "./vad.js";
import { callLog } from "./callLog.js";
import { CALL_GREETING, ASR_RETRY } from "./prompts.js";

// ---------------------------------------------------------------------------
// Per-call pipeline (Exotel inbound)
//
// One CallPipeline is created per active call. It owns the ASR session, the
// endpointer, the TTS session, conversation state, and tool-result handling.
//
// Exotel specifics (https://support.exotel.com — Stream & Voicebot Applet):
//   • Media is raw/slin: 16-bit, 8 kHz, mono PCM (little-endian), base64.
//   • The caller's number, the call sid and the stream sid arrive in the
//     `start` event (not the WS URL).
//   • Outbound audio chunks MUST be a multiple of 320 bytes (20 ms @ 8 kHz),
//     otherwise the platform waits 20 ms between chunks and you hear gaps. We
//     re-chunk TTS output into 1600-byte (100 ms) frames and pad the tail.
//   • `clear` flushes the platform's playback queue — used for barge-in.
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 8000;
const LANGUAGE = process.env.AGENT_LANGUAGE ?? "hi-IN";
const TTS_VOICE = process.env.TTS_VOICE ?? "neha";
const OUT_FRAME_BYTES = 1600; // 100 ms @ 8 kHz/16-bit; multiple of 320

function digits(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

// Telephony-side initial conversation state seeded with the real caller, so the
// agent treats them as a genuine inbound caller (phone on file = their number,
// which lets lookup_order find their order) instead of a demo persona.
function initialCallState(profile: DemoCall): ConversationState {
  const now = new Date().toISOString();
  return {
    call: profile,
    collected: {},
    outcome: "in_progress",
    messages: [{ role: "system", text: profile.transcriptSeed, timestamp: now }]
  };
}

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
  let bargeInAudio = Buffer.alloc(0);
  let turnInFlight = false;
  let closed = false;
  const pendingUtterances: string[] = [];
  let retryPending = false;
  let retryAnnounced = false;
  // Persistence: the provider call sid is unique per call, so it doubles as
  // the stored call id. `started` gates end-of-call logging.
  let sessionId = call.callSid;
  let started = false;
  let ended = false;
  let turnIndex = 0;
  let turnSource: string | null = null;
  let turnTools: string[] = [];

  const sendOut = (payload: unknown) => {
    if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  const startAsr = () => {
    asr?.close().catch(() => undefined);
    asr = createSarvamAsr({ language: LANGUAGE, sampleRate: SAMPLE_RATE });
    endpointer = createEndpointer({ sampleRate: SAMPLE_RATE });

    (async () => {
      for await (const event of asr!.events()) {
        if (event.type === "final" && event.text.trim()) {
          if (pendingUtterances.length < 3) {
            retryAnnounced = false;
            retryPending = false;
            pendingUtterances.push(event.text);
          } else {
            console.warn("[telephony] caller turn queue full; requesting repetition");
            queueRetry();
          }
          void drainPending();
        } else if (event.type === "error") {
          console.warn(`[telephony] recognition unavailable: ${event.code}`);
          queueRetry();
        }
      }
    })().catch((error) => console.error("asr loop error", error));
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
    if (utterance !== undefined) await runTurn(utterance);
    else if (retryPending) {
      retryPending = false;
      await speak(ASR_RETRY);
    }
  };

  const interruptBot = () => {
    if (!botSpeaking) return;
    tts?.cancel();
    tts = null;
    botSpeaking = false;
    if (streamSid) sendOut(clearFrame(streamSid));
  };

  // Stream a TTS instance out to Exotel, re-chunked to 320-byte multiples.
  const streamTtsOut = async (instance: StreamingTts): Promise<boolean> => {
    let played = false;
    let buffer = Buffer.alloc(0);
    const flush = (final: boolean) => {
      if (closed || tts !== instance) { buffer = Buffer.alloc(0); return; }
      while (buffer.byteLength >= OUT_FRAME_BYTES) {
        if (streamSid) { sendOut(mediaFrame(streamSid, buffer.subarray(0, OUT_FRAME_BYTES))); played = true; }
        buffer = buffer.subarray(OUT_FRAME_BYTES);
      }
      if (final && buffer.byteLength > 0) {
        const pad = (320 - (buffer.byteLength % 320)) % 320;
        const frame = pad > 0 ? Buffer.concat([buffer, Buffer.alloc(pad)]) : buffer;
        if (streamSid) { sendOut(mediaFrame(streamSid, frame)); played = true; }
        buffer = Buffer.alloc(0);
      }
    };
    for await (const chunk of instance.chunks()) {
      if (closed || tts !== instance) break;
      if (chunk.pcm.byteLength > 0) {
        buffer = Buffer.concat([buffer, chunk.pcm]);
        flush(false);
      }
      if (chunk.isFinal) break;
    }
    flush(true);
    return played;
  };

  // Speak a fixed line (greeting / prompt) without invoking the agent.
  const speak = async (text: string): Promise<void> => {
    if (closed || turnInFlight) return;
    turnInFlight = true;
    try {
      // Fixed lines are rendered ahead of time (see data/prompts.json). On a
      // hit we replay bytes from disk: no network round-trip, no per-call fee,
      // and the caller hears the line immediately. A miss falls through to
      // live synthesis, so a missing or stale cache is never fatal.
      const prerendered = lookupPrompt(text, {
        voice: TTS_VOICE,
        language: LANGUAGE,
        sampleRate: SAMPLE_RATE
      });
      tts = prerendered
        ? createBufferTts(prerendered, { sampleRate: SAMPLE_RATE })
        : createSarvamTts({ voice: TTS_VOICE, language: LANGUAGE, sampleRate: SAMPLE_RATE });
      botSpeaking = true;
      const playback = streamTtsOut(tts);
      tts.push(text);
      tts.end();
      const played = await playback;
      if (text === ASR_RETRY && played) {
        void callLog.turn(sessionId, { index: ++turnIndex, callerText: null, replyText: text, source: "asr_error", toolCalls: [] });
      }
    } catch (error) {
      console.error("greeting error", error);
    } finally {
      botSpeaking = false;
      bargeInAudio = Buffer.alloc(0);
      turnInFlight = false;
      tts = null;
      void drainPending();
    }
  };

  const runTurn = async (utterance: string) => {
    if (closed || turnInFlight) return;
    turnInFlight = true;
    const index = ++turnIndex;
    // Save received speech before waiting for the model. The final report
    // upserts this same index, so hangup cannot erase an unfinished turn.
    void callLog.turn(sessionId, { index, callerText: utterance });
    const turnStart = Date.now();
    let firstTokenAt: number | null = null;
    let finalAt: number | null = null;
    let reply = "";
    turnSource = null;
    turnTools = [];
    try {
      tts = createSarvamTts({ voice: TTS_VOICE, language: LANGUAGE, sampleRate: SAMPLE_RATE });
      botSpeaking = true;

      const playback = streamTtsOut(tts!);

      for await (const event of streamAgent(call.callSid, utterance, conversation, sessionId)) {
        if (closed) break;
        if (event.type === "token") {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          reply += event.text;
        }
        if (event.type === "final") finalAt = Date.now();
        handleAgentEvent(event);
      }
      tts?.end();
      await playback;
    } catch (error) {
      console.error("turn error", error);
    } finally {
      botSpeaking = false;
      bargeInAudio = Buffer.alloc(0);
      turnInFlight = false;
      tts = null;
      const since = (at: number | null) => (at === null ? null : at - turnStart);
      void callLog.turn(sessionId, {
        index,
        callerText: utterance,
        replyText: reply,
        llmFirstTokenMs: since(firstTokenAt),
        llmTotalMs: since(finalAt),
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

  const handleAgentEvent = (event: ChatStreamEvent) => {
    switch (event.type) {
      case "token":
        tts?.push(event.text);
        break;
      case "tool_result":
        turnTools.push(event.result.name);
        handleToolResult(event.result);
        break;
      case "final":
        conversation = event.state;
        turnSource = event.source;
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
      if (closed) return;
      switch (event.event) {
        case "connected":
          // No-op; "start" gives us the streamSid + caller details.
          break;
        case "start": {
          if (started) break;
          call.callSid = event.start?.call_sid || call.callSid;
          sessionId = call.callSid;
          streamSid = event.stream_sid ?? "";
          // The caller's real number arrives here — update the profile so the
          // agent looks them up by it.
          const from = event.start?.from ?? call.fromNumber;
          const to = event.start?.to ?? call.toNumber;
          call.fromNumber = from;
          call.toNumber = to;
          call.profile = { ...call.profile, phone: digits(from) };
          conversation = initialCallState(call.profile);
          console.log(`[telephony] start call=${call.callSid} from=${from} to=${to} stream=${streamSid}`);
          started = true;
          void callLog.start({
            id: sessionId,
            provider: call.provider === "twilio" ? "twilio" : "exotel",
            providerSid: call.callSid,
            fromNumber: from,
            toNumber: to,
            callerName: call.profile.callerName,
            callerType: call.profile.callerType,
            isTest: process.env.CALLS_ARE_TEST === "true",
            language: LANGUAGE,
            metadata: { streamSid }
          });

          startAsr();
          // Greet immediately and reliably (does not depend on the LLM).
          void speak(CALL_GREETING);
          break;
        }
        case "media": {
          if (!asr || !endpointer) return;
          const pcm = Buffer.from(event.media.payload, "base64");
          endpointer.feed(pcm);
          if (botSpeaking) {
            // Keep a bounded pre-roll so the words that trigger interruption
            // survive the voice-activity threshold.
            bargeInAudio = Buffer.from(Buffer.concat([bargeInAudio, pcm]).subarray(-Math.round(SAMPLE_RATE * 2 * 0.8)));
            if (endpointer.voicedMs() <= 200) return;
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
      if (closed) return;
      const endedAt = new Date().toISOString();
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
        void callLog.end(sessionId, { outcome: conversation?.outcome, endedAt });
      }
    }
  };
}
