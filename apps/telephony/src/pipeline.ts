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
import { createEndpointer, type Endpointer } from "./vad.js";

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
const GREETING =
  process.env.CALL_GREETING ??
  "Namaste! Madhusudan family se baat ho rahi hai. Main aapki AI assistant hoon. Bataiye, milk, ghee, paneer, dahi ya kisi order ke baare mein kaise madad karun?";

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
  let turnInFlight = false;

  const sendOut = (payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  const startAsr = () => {
    asr?.close().catch(() => undefined);
    asr = createSarvamAsr({ language: LANGUAGE, sampleRate: SAMPLE_RATE });
    endpointer = createEndpointer({ sampleRate: SAMPLE_RATE });

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

  // Stream a TTS instance out to Exotel, re-chunked to 320-byte multiples.
  const streamTtsOut = async (instance: StreamingTts): Promise<void> => {
    let buffer = Buffer.alloc(0);
    const flush = (final: boolean) => {
      while (buffer.byteLength >= OUT_FRAME_BYTES) {
        if (streamSid) sendOut(mediaFrame(streamSid, buffer.subarray(0, OUT_FRAME_BYTES)));
        buffer = buffer.subarray(OUT_FRAME_BYTES);
      }
      if (final && buffer.byteLength > 0) {
        const pad = (320 - (buffer.byteLength % 320)) % 320;
        const frame = pad > 0 ? Buffer.concat([buffer, Buffer.alloc(pad)]) : buffer;
        if (streamSid) sendOut(mediaFrame(streamSid, frame));
        buffer = Buffer.alloc(0);
      }
    };
    for await (const chunk of instance.chunks()) {
      if (chunk.pcm.byteLength > 0) {
        buffer = Buffer.concat([buffer, chunk.pcm]);
        flush(false);
      }
      if (chunk.isFinal) break;
    }
    flush(true);
  };

  // Speak a fixed line (greeting / prompt) without invoking the agent.
  const speak = async (text: string): Promise<void> => {
    if (turnInFlight) return;
    turnInFlight = true;
    try {
      tts = createSarvamTts({ voice: TTS_VOICE, language: LANGUAGE, sampleRate: SAMPLE_RATE });
      botSpeaking = true;
      const playback = streamTtsOut(tts);
      tts.push(text);
      tts.end();
      await playback;
    } catch (error) {
      console.error("greeting error", error);
    } finally {
      botSpeaking = false;
      turnInFlight = false;
    }
  };

  const runTurn = async (utterance: string) => {
    if (turnInFlight) return; // simple lock; production uses a real queue.
    turnInFlight = true;
    try {
      tts = createSarvamTts({ voice: TTS_VOICE, language: LANGUAGE, sampleRate: SAMPLE_RATE });
      botSpeaking = true;

      const playback = streamTtsOut(tts!);

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
          // No-op; "start" gives us the streamSid + caller details.
          break;
        case "start": {
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

          startAsr();
          // Greet immediately and reliably (does not depend on the LLM).
          void speak(GREETING);
          break;
        }
        case "media": {
          if (!asr || !endpointer) return;
          const pcm = Buffer.from(event.media.payload, "base64");
          endpointer.feed(pcm);
          if (botSpeaking && endpointer.voicedMs() > 200) {
            // Caller is talking over the bot — interrupt.
            interruptBot();
          }
          if (!botSpeaking) await asr.feed(pcm);
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
