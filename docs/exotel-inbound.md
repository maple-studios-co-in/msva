# Real inbound calls with Exotel

Wire a real phone number to the MSVA agent so customers can dial in and talk to
it. This uses Exotel's **Voicebot Applet (bidirectional streaming / AgentStream)**,
which streams the caller's audio to our `/voice` WebSocket and plays our audio
back. The same ASR → agent → TTS pipeline that powers the in-browser Live Call
handles the phone call.

## How it fits together

```
Caller ─dials─► ExoPhone ─► Exotel Call Flow (App)
                                   │  Voicebot applet
                                   ▼
              wss://msva.maplestudios.co.in/voice  ──►  msva-telephony (:4200)
                                                          ASR · VAD · agent · TTS
                                                          ◄── audio back to caller
```

Audio is **8 kHz, 16-bit, mono PCM (slin), base64** — our pipeline already
matches this, and re-chunks outbound audio into 320-byte multiples as Exotel
requires.

## Prerequisites

- The app is live at `https://msva.maplestudios.co.in` and `pm2 status` shows
  **msva-telephony** online (`curl -s localhost:4200/health` → `publicWsUrl: wss://msva.maplestudios.co.in/voice`).
- `SARVAM_API_KEY` is set in `apps/telephony/.env` (real ASR/TTS).
- In `apps/telephony/.env`: `PUBLIC_WS_HOST=msva.maplestudios.co.in` and
  `PUBLIC_WS_SCHEME=wss`. Optionally set `CALL_GREETING` and `TTS_VOICE`.
- nginx is proxying `/voice` with WebSocket upgrade (the `deploy/nginx-msva.conf`
  vhost already does this) and TLS is valid.

## Step 1 — Get a number + enable streaming

You said the account exists but there's no number yet.

1. In the Exotel dashboard, provision an **ExoPhone** (a number) under your
   account's numbers/ExoPhones section.
2. **Voice Streaming / AgentStream (Voicebot applet) is a gated feature.** If you
   don't see the Voicebot/Stream applet in App Bazaar, ask your Exotel account
   manager / support to **enable Voice Streaming (AgentStream / Voicebot Bidirectional)**
   on your account. (It's the beta streaming product.)

## Step 2 — Build the Call Flow (App)

1. Exotel dashboard → **App Bazaar → Create App** (a "Call Flow").
2. Add a **Voicebot** applet (bidirectional streaming).
3. Configure its **WebSocket URL**:
   ```
   wss://msva.maplestudios.co.in/voice
   ```
   (You can append query params like `?bot=msva` — they're optional; the caller
   number arrives in the stream's `start` event regardless.)
4. Save and **publish** the App.

> Note: Exotel's Voicebot applet connects to your WS URL directly — you do **not**
> need the `/exotel/incoming` webhook for this flow. (That endpoint exists only
> for the older Passthru/ExoML style and is harmless to ignore.)

## Step 3 — Map the App to your ExoPhone

In the ExoPhone's settings, set the **incoming call** action to the App you just
created. Now any call to that number runs the flow → opens the stream to MSVA.

## Step 4 — Seed a test caller (so order lookup works)

So the agent can look *you* up by your number during the test, add an order for
your phone to `data/orders.json`, e.g.:

```json
{
  "orderId": "MS-ORD-9001",
  "reference": "9001",
  "phone": "9XXXXXXXXX",
  "callerName": "Test Caller",
  "status": "out_for_delivery",
  "eta": "aaj shaam 7 baje tak",
  "area": "Ghaziabad",
  "items": ["Toned Milk 500ml x10"],
  "carrier": "Route-3 van",
  "note": "Test order for live call."
}
```

Then `pm2 restart msva-api`.

## Step 5 — Call it

Dial the ExoPhone from any phone. You should hear the Hinglish greeting, then be
able to talk — ask "mera order kahan hai?" and the agent will look it up by your
number. Watch it live:

```bash
pm2 logs msva-telephony
# [telephony] start call=... from=+91XXXXXXXXXX to=... stream=...
```

## Cloudflare / WebSocket note

Exotel must open a `wss` connection to the origin. Cloudflare's proxy (orange
cloud) supports WebSockets and usually works. If you see the call connect but no
audio, or the stream drops, the most reliable fix is to give the media stream a
**DNS-only** hostname so Exotel hits the VPS directly:

1. Add an A record `stream.maplestudios.co.in` → VPS IP, **grey cloud (DNS only)**.
2. `sudo certbot --nginx -d stream.maplestudios.co.in` (add the same vhost for it,
   or just the `/voice` location).
3. Set `PUBLIC_WS_HOST=stream.maplestudios.co.in` in `apps/telephony/.env`,
   `pm2 restart msva-telephony`, and point the Voicebot applet at
   `wss://stream.maplestudios.co.in/voice`.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Call connects, silence | Sarvam key missing in `apps/telephony/.env`; check `pm2 logs msva-telephony`. |
| Choppy / gapped agent audio | Should be handled (320-byte framing). Confirm `speech_sample_rate=8000` path; check CPU load. |
| One-way audio (you hear nothing) | Outbound frames not reaching Exotel — confirm `stream_sid` captured (see start log) and nginx WS upgrade on `/voice`. |
| Stream never opens | Voicebot streaming not enabled on the account, or Cloudflare blocking WS — try the DNS-only hostname above. |
| Greeting fine but replies slow | On a CPU box set `AGENT_LLM=off` in `apps/api/.env` + `pm2 restart msva-api` for instant replies. |
| Caller not recognized | Add their number to `data/orders.json` (Step 4). |

## Outbound calls (later)

This guide covers **inbound**. Outbound (the system places a call and connects
the agent) uses Exotel's Connect/Campaign APIs to dial a number and attach the
same Voicebot applet. Ask and we'll wire it next.
