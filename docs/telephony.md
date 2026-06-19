# Telephony

`apps/telephony` is the bridge between a telephony provider (Exotel by default) and the streaming voice agent in `apps/api`. This doc covers the lifecycle of a call, the adapter interfaces, and the swap-in points for providers and providers' competitors.

For run instructions and env vars, see [`apps/telephony/README.md`](../apps/telephony/README.md).

## Call lifecycle

```
1. Inbound call arrives at Exotel
       │
2. Exotel POSTs /exotel/incoming  ──► we return ExoML <Stream url="wss://…/voice"/>
       │
3. Exotel opens WSS to /voice
       │
4. Exotel sends `connected` then `start` events  ──► we create a CallPipeline
       │
5. Pipeline opens an ASR session + spawns a "greeting" turn
       │
   ┌───┴────────────────────────────────────────────────────────┐
   │  Loop:                                                     │
   │  • Exotel sends `media` (8kHz PCM, base64)                 │
   │    → endpointer.feed(pcm)                                  │
   │    → asr.feed(pcm)                                         │
   │  • If bot is speaking and caller voice detected:           │
   │    → tts.cancel(); send `clear` frame; reset ASR           │
   │  • If endpointer.endpointed():                             │
   │    → asr.endpoint()                                        │
   │    → on `final` transcript:                                │
   │       • open new TTS                                       │
   │       • streamAgent(callSid, transcript, state)            │
   │       • for each `token` event → tts.push(text)            │
   │       • for each TTS chunk → send media frame to Exotel    │
   │       • on `final` event → save state                      │
   │       • on `tool_result(transfer_to_human)` → warm xfer    │
   └────────────────────────────────────────────────────────────┘
       │
6. Exotel sends `stop` event (caller hung up)
       │
7. Pipeline closes ASR + TTS, persists CallTurns + transcript
```

## Pipeline contract

`createCallPipeline(ws, call)` returns:

```ts
type CallPipeline = {
  call: TelephonyCall;
  handleInbound(event: ExotelInboundEvent): Promise<void>;
  close(): Promise<void>;
};
```

One pipeline per active call. State is held in closures over `createCallPipeline`. The same pipeline can be reused under Twilio with only the `exotel.ts` framing module swapped.

## Adapter interfaces

The two boundaries that matter — ASR and TTS — are defined as small interfaces so providers are swappable without touching the pipeline.

### `StreamingAsr` (`src/asr/index.ts`)

```ts
type StreamingAsr = {
  feed(pcm: Buffer): Promise<void>;
  endpoint(): Promise<void>;
  events(): AsyncIterable<AsrEvent>;
  close(): Promise<void>;
};
```

Implementations: `sarvam.ts` (stub today, real WS once `SARVAM_API_KEY` is set). To add Bhashini, Deepgram, or Whisper: create `src/asr/<provider>.ts` exporting an `AsrFactory`, then choose at boot time via env var.

### `StreamingTts` (`src/tts/index.ts`)

```ts
type StreamingTts = {
  push(text: string): void;
  end(): void;
  cancel(): void;
  chunks(): AsyncIterable<TtsChunk>;
};
```

The pipeline pushes token deltas as they arrive from the LLM; the implementation is responsible for chunking on sensible boundaries (sentence-end or ~80 chars) so the first audio chunk ships before the LLM finishes generating.

### `Endpointer` (`src/vad.ts`)

```ts
type Endpointer = {
  feed(pcm: Buffer): void;
  endpointed(): boolean;
  reset(): void;
  voicedMs(): number;
};
```

Default: energy-RMS. Production: replace with Silero VAD (via `onnxruntime-node`). The interface is what matters — the pipeline doesn't care which implementation is behind it.

## Barge-in

The hardest part of a voice agent that "feels good." The current implementation:

1. While the bot is speaking, every inbound media frame still goes to the endpointer.
2. If `endpointer.voicedMs() > 200` while `botSpeaking === true`, we treat that as interruption.
3. Cancel the in-flight TTS (`tts.cancel()`), drop any queued audio.
4. Send a `clear` frame to Exotel so the carrier's playback buffer also drops.
5. Start a fresh ASR utterance so the caller's interrupting words are captured cleanly.

Production tuning: a stricter Silero VAD pass before triggering interruption avoids false positives on coughs, background noise, and the caller's own "haan, haan" agreement noises.

## Provider swap notes

### Twilio

- Replace `exomlForStream` with TwiML `<Connect><Stream>`.
- Twilio Media Streams uses µ-law instead of PCM — add a µ-law decoder before `asr.feed()` and a µ-law encoder after TTS.
- `start` / `media` / `stop` / `mark` event shapes are nearly identical; minor field renames only.

### Plivo

- ExoML and TwiML are both close cousins; Plivo's PlivoML uses the same `<Stream>` verb.
- Audio format defaults to µ-law (configurable).

### Airtel IQ / Knowlarity

- These wrap their own MML; check current API docs. They typically deliver audio via SIP rather than WS, in which case you'd swap the inbound transport for a SIP gateway (Asterisk / FreeSWITCH / Janus) that bridges to our existing WS handler.

## Telemetry (planned)

Per turn, the pipeline should populate a `CallTurn`:

| Field | Source |
|---|---|
| `asrMs` | between `endpoint()` call and first `final` ASR event |
| `llmFirstTokenMs` | between SSE start and first `token` event |
| `llmTotalMs` | between SSE start and `final` event |
| `ttsFirstByteMs` | between first `token` and first non-empty TTS chunk |
| `ttsTotalMs` | between first `token` and last TTS chunk |
| `interrupted` | true if caller barged in mid-reply |

Persistence + dashboard surfacing are tracked in [calling-roadmap.md](./calling-roadmap.md) Phase 3.

## Known limitations of the skeleton

- ASR + TTS are stubs; real audio requires `SARVAM_API_KEY` and the TODOs in the adapters being filled in.
- VAD is energy-based — replace with Silero before going live.
- Conversation state is in-memory per WS; a service restart drops the call. Move to Redis keyed on `callSid` for production.
- Tool calls are synthesized deterministically from the inferred outcome. Move to LLM-emitted tool calls once on a model with reliable function calling.
- No call recording or consent banner. Required by the DPDP Act and Exotel ToS before going live.
