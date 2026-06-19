# Live Call — talking to the voice agent

There are now two ways to actually *talk* to the Madhusudan voice agent and hear
it talk back, both driven by the **same** brain (Sarvam ASR → Hinglish agent →
Sarvam TTS, with VAD endpointing and barge-in):

1. **In-browser call** — works on your laptop, no phone carrier needed.
2. **Real phone call** — a real PSTN number via Exotel or Twilio.

The browser is simply treated as one more telephony transport. The pipeline
code that decides *when the caller stopped talking*, *what the agent says*, and
*when to interrupt* is identical in both cases.

```
            ┌──────────── shared brain (apps/api) ────────────┐
mic / phone │  Sarvam ASR → agent (Ollama+fallback) → Sarvam  │ speaker / phone
   audio ──►│  TTS, with VAD endpointing + barge-in           │──► audio
            └─────────────────────────────────────────────────┘
   ▲                                                              ▲
   │  /browser  (web app, 16 kHz PCM over WebSocket)              │
   │  /voice    (Exotel / Twilio media stream)                    │
```

---

## 1. In-browser call (recommended for demos)

### Prerequisites
- A **Sarvam API key** in both `apps/api/.env` and `apps/telephony/.env`
  (`SARVAM_API_KEY=...`). Real speech-to-text and the agent's voice both need it.
- Optional but recommended: **Ollama** running locally for natural replies.
  Without it the agent still talks, using deterministic fallback lines.

### Run it
```bash
pnpm install
pnpm dev:all      # starts api (4100) + web (5173) + telephony (4200)
```
Then open http://localhost:5173, click **Live Call** in the sidebar, pick a
caller profile and an agent voice, and press **Call**.

- Allow microphone access when the browser asks.
- After the greeting, just start speaking in Hindi/Hinglish. Pause and the agent
  replies in voice.
- **Talk over the agent to interrupt it** (barge-in) — it stops and listens.
- **Use headphones.** Without echo cancellation doing all the work, the agent's
  own voice from your speakers can make it interrupt itself.

### How the audio flows
- The browser captures the mic, downsamples to **16 kHz mono 16-bit PCM** in an
  `AudioWorklet`, and streams raw frames over a WebSocket to
  `ws://localhost:4200/browser`.
- The telephony service runs Sarvam ASR, detects end-of-utterance with the
  energy VAD, calls the agent over SSE, and streams Sarvam TTS audio back as
  PCM, which the browser plays gaplessly.
- Live captions, the call outcome, and the "listening / thinking / speaking"
  state are sent as small JSON control messages on the same socket.

### Config (optional)
Web app (`apps/web/.env`, all optional):
```
VITE_TELEPHONY_WS_URL=ws://localhost:4200   # where the browser call connects
VITE_API_BASE_URL=http://localhost:4100
```
Telephony VAD tuning (`apps/telephony/.env`, all optional — defaults shown):
```
BROWSER_SAMPLE_RATE=16000
BROWSER_VAD_SILENCE_MS=750     # silence before the agent answers
BROWSER_VAD_ENERGY_FLOOR=550   # raise if it triggers on background noise
BROWSER_VAD_MIN_VOICED_MS=280
BROWSER_BARGE_IN_MS=420        # how much speech interrupts the agent
```

---

## 2. Real phone call (Exotel)

The telephony service already speaks Exotel's Voicebot media-stream protocol.

1. Put your Sarvam key in `apps/telephony/.env`.
2. Expose the service publicly (Exotel must reach it):
   ```bash
   ngrok http 4200
   ```
   Set in `apps/telephony/.env`:
   ```
   PUBLIC_WS_HOST=<your-ngrok-host>      # e.g. a1b2c3.ngrok-free.app  (no scheme)
   PUBLIC_WS_SCHEME=wss
   ```
3. In the Exotel dashboard → **App Bazaar → Voicebot Applet**, create a flow
   whose URL is `https://<your-ngrok-host>/exotel/incoming`, and map it to one
   of your DIDs (phone numbers).
4. Start everything (`pnpm dev:all`) and call the DID from any phone.

When a call lands, Exotel POSTs to `/exotel/incoming`; the service returns ExoML
that opens a media-stream WebSocket to `/voice`, and the same brain handles the
call.

## 3. Real phone call (Twilio)

Twilio Media Streams use the same idea with two differences:
- Return **TwiML** `<Connect><Stream url="wss://…/voice"/></Connect>` instead of
  ExoML (swap `exomlForStream` in `apps/telephony/src/server.ts`).
- Twilio media is **8 kHz µ-law**, not linear PCM — add a µ-law→PCM16 decode on
  inbound frames and PCM16→µ-law encode on outbound in the pipeline before/after
  the ASR/TTS calls. The WebSocket framing is otherwise nearly identical.

---

## Production notes (carry over from the skeleton)
- The energy VAD is fine for demos; swap to Silero VAD before going live.
- Conversation state is in-memory per socket — persist to Redis keyed on the
  call id so a restart mid-call can recover.
- Add a recording/consent banner before launching in India (DPDP Act + Exotel
  ToS).
