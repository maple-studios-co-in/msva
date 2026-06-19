// ---------------------------------------------------------------------------
// Exotel framing
//
// Exotel's Voicebot Applet POSTs to the configured URL when a call comes in
// (form-encoded params: CallSid, From, To, Direction, etc). The HTTP
// response is "ExoML" — Exotel's TwiML dialect — and we return a <Stream>
// verb that opens a WebSocket to this same service.
//
// Once the WS is connected Exotel sends JSON messages framed as:
//   { event: "connected", protocol, version }
//   { event: "start",     stream_sid, account_sid, call_sid, custom_parameters }
//   { event: "media",     stream_sid, media: { payload, timestamp, chunk } }
//   { event: "stop",      stream_sid, account_sid, call_sid }
//   { event: "mark",      stream_sid, mark: { name } }
//
// Audio payloads are base64-encoded 8kHz 16-bit signed-PCM mono (this is the
// Exotel default; Twilio Media Streams uses µ-law instead — the pipeline
// converts as needed before handing buffers to the ASR adapter).
// ---------------------------------------------------------------------------

export type ExotelInboundEvent =
  | { event: "connected"; protocol: string; version: string }
  | {
      event: "start";
      stream_sid: string;
      sequence_number: string;
      start: {
        account_sid: string;
        call_sid: string;
        from: string;
        to: string;
        custom_parameters?: Record<string, string>;
        media_format: { encoding: string; sample_rate: number; bit_rate?: number };
      };
    }
  | {
      event: "media";
      stream_sid: string;
      sequence_number: string;
      media: { chunk: string; timestamp: string; payload: string };
    }
  | { event: "stop"; stream_sid: string; stop: { account_sid: string; call_sid: string } }
  | { event: "mark"; stream_sid: string; mark: { name: string } };

export type ExotelOutboundEvent =
  | {
      event: "media";
      stream_sid: string;
      media: { payload: string };
    }
  | { event: "mark"; stream_sid: string; mark: { name: string } }
  | { event: "clear"; stream_sid: string };

/**
 * Build the ExoML response that tells Exotel to open a WebSocket to us.
 * `publicWsUrl` must be reachable from Exotel's edge — in dev that means an
 * ngrok / Cloudflare Tunnel pointing at this service.
 */
export function exomlForStream(publicWsUrl: string, greeting?: string): string {
  const greet = greeting
    ? `<Say voice="female" language="hi-IN">${escapeXml(greeting)}</Say>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greet}
  <Stream url="${escapeXml(publicWsUrl)}">
    <Parameter name="bot" value="msva" />
  </Stream>
</Response>`;
}

/** Wrap an outbound PCM buffer into the Exotel media event shape. */
export function mediaFrame(streamSid: string, pcm: Buffer): ExotelOutboundEvent {
  return {
    event: "media",
    stream_sid: streamSid,
    media: { payload: pcm.toString("base64") }
  };
}

/** Tell Exotel to drop everything currently queued for playback — used for barge-in. */
export function clearFrame(streamSid: string): ExotelOutboundEvent {
  return { event: "clear", stream_sid: streamSid };
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
