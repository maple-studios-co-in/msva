// Contract for the Exotel wire protocol. These frames are what a real call
// looks like on the socket, so the simulator and the live handler can be held
// to the same shape.

import { describe, expect, it } from "vitest";
import {
  clearFrame,
  connectedFrame,
  exomlForStream,
  inboundMediaFrame,
  mediaFrame,
  parseOutboundFrame,
  startFrame,
  stopFrame
} from "./exotel.js";

describe("exomlForStream", () => {
  it("points Exotel at our socket", () => {
    const xml = exomlForStream("wss://example.test/voice");
    expect(xml).toContain('<Stream url="wss://example.test/voice">');
  });

  it("escapes the url so a query string cannot break the document", () => {
    const xml = exomlForStream("wss://example.test/voice?a=1&b=2");
    expect(xml).toContain("a=1&amp;b=2");
    expect(xml).not.toContain("a=1&b=2");
  });

  it("escapes a greeting rather than letting it inject markup", () => {
    const xml = exomlForStream("wss://example.test/voice", '<script>"hi"</script>');
    expect(xml).not.toContain("<script>");
    expect(xml).toContain("&lt;script&gt;");
  });

  it("omits the Say verb when no greeting is given", () => {
    expect(exomlForStream("wss://example.test/voice")).not.toContain("<Say");
  });
});

describe("caller-side frames", () => {
  it("opens with the connected handshake", () => {
    expect(connectedFrame()).toEqual({ event: "connected", protocol: "Call", version: "1.0.0" });
  });

  it("describes the call on start", () => {
    const frame = startFrame({
      streamSid: "s1",
      callSid: "c1",
      accountSid: "a1",
      from: "+919818160910",
      to: "+919000000000",
      sampleRate: 8000
    });
    expect(frame.event).toBe("start");
    expect(frame.stream_sid).toBe("s1");
    expect(frame.start.call_sid).toBe("c1");
    expect(frame.start.from).toBe("+919818160910");
    expect(frame.start.media_format).toEqual({ encoding: "audio/x-l16", sample_rate: 8000 });
  });

  it("numbers frames in sequence so ordering is checkable", () => {
    const a = inboundMediaFrame("s1", Buffer.alloc(4), 1, 0);
    const b = inboundMediaFrame("s1", Buffer.alloc(4), 2, 20);
    expect(a.sequence_number).toBe("1");
    expect(b.sequence_number).toBe("2");
    expect(b.media.timestamp).toBe("20");
  });

  it("base64-encodes caller audio", () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const frame = inboundMediaFrame("s1", pcm, 1, 0);
    expect(Buffer.from(frame.media.payload, "base64")).toEqual(pcm);
  });

  it("closes with stop carrying the same identifiers", () => {
    const frame = stopFrame("s1", "c1", "a1");
    expect(frame).toEqual({
      event: "stop",
      stream_sid: "s1",
      stop: { account_sid: "a1", call_sid: "c1" }
    });
  });
});

describe("agent-side frames", () => {
  it("base64-encodes outbound audio", () => {
    const pcm = Buffer.from([0x10, 0x20]);
    expect(mediaFrame("s1", pcm).media.payload).toBe(pcm.toString("base64"));
  });

  it("clears the playback queue for barge-in", () => {
    expect(clearFrame("s1")).toEqual({ event: "clear", stream_sid: "s1" });
  });
});

describe("parseOutboundFrame", () => {
  it("decodes media back to the original bytes", () => {
    const pcm = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const parsed = parseOutboundFrame(JSON.stringify(mediaFrame("s1", pcm)));
    expect(parsed?.event).toBe("media");
    if (parsed?.event === "media") expect(parsed.pcm).toEqual(pcm);
  });

  it("recognises a clear", () => {
    expect(parseOutboundFrame(JSON.stringify(clearFrame("s1")))?.event).toBe("clear");
  });

  it("returns null for malformed json rather than throwing", () => {
    expect(parseOutboundFrame("not json")).toBeNull();
  });

  it("returns null for an unknown event rather than throwing", () => {
    expect(parseOutboundFrame(JSON.stringify({ event: "surprise" }))).toBeNull();
  });

  it("returns null when media carries no payload", () => {
    expect(parseOutboundFrame(JSON.stringify({ event: "media", stream_sid: "s" }))).toBeNull();
  });
});
