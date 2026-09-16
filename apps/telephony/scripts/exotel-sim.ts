// ---------------------------------------------------------------------------
// Exotel call simulator
//
//   pnpm --filter @msva/telephony sim -- --audio caller.wav
//
// Pretends to be Exotel. Opens a WebSocket to our own telephony service,
// performs the connected/start handshake, streams a WAV down the socket in
// real time as base64 media frames, collects whatever the agent plays back,
// and writes it to a WAV you can listen to.
//
// Why this exists: an Exotel number needs company KYC and a support request to
// enable streaming, which takes days. This exercises every line of our Exotel
// handling without any of that, so when a real number does arrive the only
// unknown left is Exotel's own edge.
//
// What it does NOT prove: real network jitter, real codec artefacts, and
// whether Exotel's live framing matches their documentation. Treat a green run
// as "our side is correct", not "the integration works".
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket } from "ws";
import "../src/env.js";
import {
  connectedFrame,
  inboundMediaFrame,
  parseOutboundFrame,
  startFrame,
  stopFrame
} from "../src/exotel.js";
import { decodeWav, encodeWav, resamplePcm16, toMono } from "../src/audio/wav.js";

type Args = {
  url: string;
  audio: string | null;
  out: string;
  from: string;
  to: string;
  silenceMs: number;
  trailingSilenceMs: number;
  hangupAfterMs: number;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const port = process.env.TELEPHONY_PORT ?? "4200";
  return {
    url: get("url", `ws://127.0.0.1:${port}/voice`),
    audio: argv.includes("--audio") ? get("audio", "") || null : null,
    out: get("out", "agent-reply.wav"),
    from: get("from", "+919818160910"),
    to: get("to", "+919000000000"),
    silenceMs: Number(get("silence", "4000")),
    // A real caller stops talking. Without a trailing pause the endpointer
    // never fires and the agent waits forever for the utterance to end.
    trailingSilenceMs: Number(get("trailing-silence", "1500")),
    hangupAfterMs: Number(get("hangup-after", "25000"))
  };
}

const SAMPLE_RATE = 8000;
const FRAME_MS = 20; // Exotel streams 20 ms frames
const FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS * 2;

const silence = (ms: number): Buffer => Buffer.alloc(Math.round((SAMPLE_RATE / 1000) * ms) * 2);

/** Caller audio: a WAV converted to 8 kHz mono, or silence if none was given. */
function callerAudio(path: string | null, silenceMs: number, trailingMs: number): Buffer {
  if (!path) return silence(silenceMs);
  const decoded = decodeWav(readFileSync(resolve(process.cwd(), path)));
  const mono = toMono(decoded.pcm, decoded.channels);
  const pcm = resamplePcm16(mono, decoded.sampleRate, SAMPLE_RATE);
  console.log(
    `caller audio: ${path} (${decoded.sampleRate} Hz, ${decoded.channels}ch) ` +
      `-> ${SAMPLE_RATE} Hz mono, ${(pcm.byteLength / 2 / SAMPLE_RATE).toFixed(1)}s ` +
      `+ ${trailingMs} ms trailing pause`
  );
  return Buffer.concat([pcm, silence(trailingMs)]);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const streamSid = `sim-stream-${Date.now()}`;
  const callSid = `sim-call-${Date.now()}`;
  const accountSid = "sim-account";
  const pcm = callerAudio(args.audio, args.silenceMs, args.trailingSilenceMs);
  // Where the caller's speech ends and the trailing pause begins. Reply
  // latency is measured from here, because that is the moment a real caller
  // stops talking and starts waiting.
  const speechEndByte = args.audio ? pcm.byteLength - silence(args.trailingSilenceMs).byteLength : pcm.byteLength;

  console.log(`connecting to ${args.url}`);
  const ws = new WebSocket(args.url);

  const replyChunks: Buffer[] = [];
  let clears = 0;
  let firstReplyAt: number | null = null;
  let startSentAt = 0;

  ws.on("message", (raw: Buffer) => {
    const frame = parseOutboundFrame(raw.toString("utf8"));
    if (!frame) return;
    if (frame.event === "media") {
      if (firstReplyAt === null) firstReplyAt = Date.now();
      replyChunks.push(frame.pcm);
    } else if (frame.event === "clear") {
      // Barge-in: the agent is dropping whatever it queued. Mirror that, or
      // the saved file contains audio the caller never actually heard.
      clears += 1;
      replyChunks.length = 0;
      firstReplyAt = null;
    }
  });

  await new Promise<void>((ok, fail) => {
    ws.once("open", () => ok());
    ws.once("error", fail);
  });

  const send = (frame: unknown): void => ws.send(JSON.stringify(frame));

  send(connectedFrame());
  startSentAt = Date.now();
  send(startFrame({ streamSid, callSid, accountSid, from: args.from, to: args.to, sampleRate: SAMPLE_RATE }));
  console.log(`call started: ${args.from} -> ${args.to}`);

  // Stream the caller's audio at wall-clock speed so endpointing and barge-in
  // see the same timing they would on a real call.
  let sequence = 2;
  let speechEndedAt = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += FRAME_BYTES) {
    if (speechEndedAt === 0 && offset >= speechEndByte) speechEndedAt = Date.now();
    if (ws.readyState !== WebSocket.OPEN) break;
    const slice = pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.byteLength));
    send(inboundMediaFrame(streamSid, slice, sequence, (offset / FRAME_BYTES) * FRAME_MS));
    sequence += 1;
    await sleep(FRAME_MS);
  }
  if (speechEndedAt === 0) speechEndedAt = Date.now();
  console.log(`caller audio sent (${sequence - 2} frames), listening for the reply`);

  // Keep the socket open so the agent can finish talking.
  const deadline = Date.now() + args.hangupAfterMs;
  let lastSeen = replyChunks.length;
  let quietSince = Date.now();
  while (Date.now() < deadline && ws.readyState === WebSocket.OPEN) {
    await sleep(250);
    if (replyChunks.length !== lastSeen) {
      lastSeen = replyChunks.length;
      quietSince = Date.now();
    } else if (firstReplyAt !== null && Date.now() - quietSince > 2500) {
      break; // agent started, then went quiet for 2.5s — treat the turn as done
    }
  }

  if (ws.readyState === WebSocket.OPEN) {
    send(stopFrame(streamSid, callSid, accountSid));
    await sleep(200);
    ws.close();
  }

  const reply = Buffer.concat(replyChunks);
  const seconds = reply.byteLength / 2 / SAMPLE_RATE;
  console.log("\n--- result ---");
  console.log(`agent audio      ${seconds.toFixed(1)}s (${(reply.byteLength / 1024).toFixed(0)} KB)`);
  // Two different numbers, and the difference matters. The first is how long
  // the caller waited from dialling before hearing anything at all. The second
  // is the one the proposal sells: how long after the caller stops talking
  // before the agent answers.
  console.log(`first audio      ${firstReplyAt ? `${firstReplyAt - startSentAt} ms after call start` : "none received"}`);
  console.log(
    `reply latency    ${
      firstReplyAt && firstReplyAt > speechEndedAt
        ? `${firstReplyAt - speechEndedAt} ms after caller stopped`
        : "n/a (agent spoke first)"
    }`
  );
  console.log(`barge-in clears  ${clears}`);

  if (reply.byteLength === 0) {
    console.error("\nThe agent sent no audio. Is the telephony service running, and is SARVAM_API_KEY set?");
    process.exit(1);
  }
  const out = resolve(process.cwd(), args.out);
  writeFileSync(out, encodeWav(reply, SAMPLE_RATE));
  console.log(`saved            ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
