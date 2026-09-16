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
export function mediaFrame(
  streamSid: string,
  pcm: Buffer
): Extract<ExotelOutboundEvent, { event: "media" }> {
  return {
    event: "media",
    stream_sid: streamSid,
    media: { payload: pcm.toString("base64") }
  };
}

/** Tell Exotel to drop everything currently queued for playback — used for barge-in. */
export function clearFrame(streamSid: string): Extract<ExotelOutboundEvent, { event: "clear" }> {
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

// ---------------------------------------------------------------------------
// Caller-side frames.
//
// These are what Exotel sends *us*. Production never builds them — Exotel
// does — but the local simulator (scripts/exotel-sim.ts) needs to produce
// byte-identical traffic, and keeping both sides of the protocol in one file
// is what stops the simulator drifting away from the handler it exercises.
// ---------------------------------------------------------------------------

export type StartFrameOptions = {
  streamSid: string;
  callSid: string;
  accountSid: string;
  from: string;
  to: string;
  sampleRate: number;
  customParameters?: Record<string, string>;
};

/** Handshake Exotel sends the moment the socket opens. */
export function connectedFrame(): Extract<ExotelInboundEvent, { event: "connected" }> {
  return { event: "connected", protocol: "Call", version: "1.0.0" };
}

/** Call metadata: who is calling, on which number, in what audio format. */
export function startFrame(o: StartFrameOptions): Extract<ExotelInboundEvent, { event: "start" }> {
  return {
    event: "start",
    stream_sid: o.streamSid,
    sequence_number: "1",
    start: {
      account_sid: o.accountSid,
      call_sid: o.callSid,
      from: o.from,
      to: o.to,
      ...(o.customParameters ? { custom_parameters: o.customParameters } : {}),
      media_format: { encoding: "audio/x-l16", sample_rate: o.sampleRate }
    }
  };
}

/** A slice of caller audio. `timestampMs` is milliseconds since the call began. */
export function inboundMediaFrame(
  streamSid: string,
  pcm: Buffer,
  sequence: number,
  timestampMs: number
): Extract<ExotelInboundEvent, { event: "media" }> {
  return {
    event: "media",
    stream_sid: streamSid,
    sequence_number: String(sequence),
    media: {
      chunk: String(sequence),
      timestamp: String(timestampMs),
      payload: pcm.toString("base64")
    }
  };
}

/** Caller hung up. */
export function stopFrame(
  streamSid: string,
  callSid: string,
  accountSid: string
): Extract<ExotelInboundEvent, { event: "stop" }> {
  return { event: "stop", stream_sid: streamSid, stop: { account_sid: accountSid, call_sid: callSid } };
}

export type ParsedOutbound =
  | { event: "media"; streamSid: string; pcm: Buffer }
  | { event: "clear"; streamSid: string }
  | { event: "mark"; streamSid: string; name: string };

/**
 * Decode a frame we sent back towards the caller.
 *
 * Returns null rather than throwing on anything unrecognised: this reads a
 * socket, and a harness that dies on one odd frame is worse than one that
 * skips it and keeps the call going.
 */
export function parseOutboundFrame(raw: string): ParsedOutbound | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  const streamSid = typeof frame.stream_sid === "string" ? frame.stream_sid : "";

  if (frame.event === "media") {
    const media = frame.media as { payload?: unknown } | undefined;
    if (!media || typeof media.payload !== "string") return null;
    return { event: "media", streamSid, pcm: Buffer.from(media.payload, "base64") };
  }
  if (frame.event === "clear") return { event: "clear", streamSid };
  if (frame.event === "mark") {
    const mark = frame.mark as { name?: unknown } | undefined;
    return { event: "mark", streamSid, name: typeof mark?.name === "string" ? mark.name : "" };
  }
  return null;
}
