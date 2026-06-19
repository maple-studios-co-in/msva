// ---------------------------------------------------------------------------
// callClient — in-browser "phone call" transport
//
// Captures the mic, downsamples to 16 kHz 16-bit mono PCM in an AudioWorklet,
// and streams it over a WebSocket to the telephony service's /browser
// endpoint. Incoming binary frames are TTS audio (also 16 kHz PCM) which we
// schedule for gapless playback; incoming text frames are JSON control
// messages (status, live captions, outcome, barge-in clear).
//
// The telephony service runs the same Sarvam ASR → agent → Sarvam TTS brain
// as the real phone path, so this is a faithful simulation of an actual call.
// ---------------------------------------------------------------------------

import type { LiveTurnMetrics } from "@msva/shared";

const TARGET_RATE = 16000;

const TELEPHONY_WS_URL: string =
  (import.meta.env.VITE_TELEPHONY_WS_URL as string | undefined) ?? "ws://localhost:4200";

export type CallStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ended";

export type CallEvents = {
  onStatus?: (status: CallStatus) => void;
  onUserTranscript?: (text: string, final: boolean) => void;
  onAgentTranscript?: (text: string, final: boolean) => void;
  onOutcome?: (outcome: string, collected: Record<string, string>, escalationReason: string | null) => void;
  onMetrics?: (metrics: LiveTurnMetrics) => void;
  onMicLevel?: (level: number) => void;
  onError?: (message: string) => void;
  onEnded?: () => void;
};

export type CallOptions = {
  callId: string;
  voice: string;
  language?: string;
  from?: string;
};

// AudioWorklet processor: decimate the mic stream to TARGET_RATE and post
// Int16 PCM blocks (~20 ms) back to the main thread.
const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.acc = 0;
    this.buf = [];
  }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        this.buf.push(ch[i]);
      }
    }
    if (this.buf.length >= 320) {
      const out = new Int16Array(this.buf.length);
      for (let i = 0; i < this.buf.length; i++) {
        let s = Math.max(-1, Math.min(1, this.buf[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(out.buffer, [out.buffer]);
      this.buf = [];
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

export class CallClient {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private micNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private playCursor = 0;
  private liveSources = new Set<AudioBufferSourceNode>();
  private muted = false;
  private closed = false;

  constructor(private readonly events: CallEvents) {}

  async start(options: CallOptions): Promise<void> {
    this.events.onStatus?.("connecting");

    // 1. Mic + audio graph. Echo cancellation is essential so the bot's own
    //    voice coming out of the speakers doesn't trigger false barge-in.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === "suspended") await this.ctx.resume();

    const blob = new Blob([CAPTURE_WORKLET], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
    this.micNode = new AudioWorkletNode(this.ctx, "capture-processor", {
      processorOptions: { targetRate: TARGET_RATE }
    });
    this.micNode.port.onmessage = (event) => this.onMicChunk(event.data as ArrayBuffer);
    this.sourceNode.connect(this.micNode);
    // Worklet has no audible output; connecting to destination keeps it pulled.
    this.micNode.connect(this.ctx.destination);

    // 2. WebSocket.
    const qs = new URLSearchParams({ call: options.callId, from: options.from ?? "+919000000001" });
    this.ws = new WebSocket(`${TELEPHONY_WS_URL}/browser?${qs.toString()}`);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.send({ type: "start", callId: options.callId, voice: options.voice, language: options.language });
    };
    this.ws.onmessage = (event) => this.onWsMessage(event);
    this.ws.onerror = () => this.events.onError?.("Connection error — is the telephony service running on port 4200?");
    this.ws.onclose = () => {
      if (!this.closed) this.events.onError?.("Call connection closed.");
      this.cleanup();
      this.events.onStatus?.("ended");
      this.events.onEnded?.();
    };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  async stop(): Promise<void> {
    this.closed = true;
    try {
      this.send({ type: "stop" });
    } catch {
      /* ignore */
    }
    this.ws?.close();
    this.cleanup();
    this.events.onStatus?.("ended");
    this.events.onEnded?.();
  }

  // -- mic → ws -------------------------------------------------------------
  private onMicChunk(buffer: ArrayBuffer): void {
    if (this.muted || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pcm = new Int16Array(buffer);
    // Cheap RMS level for the UI meter (0..1).
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / Math.max(1, pcm.length)) / 32768;
    this.events.onMicLevel?.(Math.min(1, rms * 4));
    this.ws.send(buffer);
  }

  // -- ws → speaker / UI ----------------------------------------------------
  private onWsMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      this.onControl(event.data);
      return;
    }
    this.playPcm(event.data as ArrayBuffer);
  }

  private onControl(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "ready":
        break;
      case "status":
        this.events.onStatus?.(msg.state as CallStatus);
        break;
      case "user_transcript":
        this.events.onUserTranscript?.(String(msg.text ?? ""), Boolean(msg.final));
        break;
      case "agent_transcript":
        this.events.onAgentTranscript?.(String(msg.text ?? ""), Boolean(msg.final));
        break;
      case "clear":
        this.flushPlayback();
        break;
      case "outcome":
        this.events.onOutcome?.(
          String(msg.outcome ?? ""),
          (msg.collected as Record<string, string>) ?? {},
          (msg.escalationReason as string | null) ?? null
        );
        break;
      case "metrics":
        this.events.onMetrics?.(msg.metrics as LiveTurnMetrics);
        break;
    }
  }

  private playPcm(buffer: ArrayBuffer): void {
    if (!this.ctx || this.closed) return;
    const pcm = new Int16Array(buffer);
    if (pcm.length === 0) return;
    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 32768;

    // AudioBuffer tagged at 16 kHz; the context resamples on playback so we
    // don't have to match the hardware sample rate.
    const audioBuffer = this.ctx.createBuffer(1, float.length, TARGET_RATE);
    audioBuffer.copyToChannel(float, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);

    const startAt = Math.max(this.ctx.currentTime + 0.02, this.playCursor);
    source.start(startAt);
    this.playCursor = startAt + audioBuffer.duration;

    this.liveSources.add(source);
    source.onended = () => this.liveSources.delete(source);
  }

  private flushPlayback(): void {
    for (const source of this.liveSources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.liveSources.clear();
    this.playCursor = this.ctx ? this.ctx.currentTime : 0;
  }

  private send(message: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private cleanup(): void {
    this.flushPlayback();
    try {
      this.micNode?.disconnect();
      this.sourceNode?.disconnect();
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.ctx?.close().catch(() => undefined);
    this.micNode = null;
    this.sourceNode = null;
    this.stream = null;
    this.ctx = null;
  }
}
