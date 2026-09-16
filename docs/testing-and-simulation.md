# Testing and simulation

## How we test

`pnpm test` runs Vitest across the workspace. Tests sit next to the code they
cover as `*.test.ts`, so anyone opening a module finds its contract in the file
beside it. They are excluded from the build output.

We write the test first. Not as ceremony: the Exotel work below is the reason.
Pacing the pre-rendered audio looked like a cosmetic detail until a test forced
the question "how long should this take?", and answering it exposed a bug that
would have silently broken barge-in on every call.

Three rules we hold to:

- **A test names the behaviour, not the implementation.** `plays at roughly
  wall-clock speed so barge-in stays possible` survives a rewrite; `calls
  setTimeout` does not.
- **A parser returns null, never throws.** Anything reading a socket or a file
  from outside our process is hostile input. Tests cover the malformed cases.
- **Slow tests earn their place.** The pacing test really does wait 600 ms,
  because faking the clock would test the fake.

## The Exotel simulator

An Exotel number needs company KYC and a support request before streaming is
switched on, which takes days. The simulator removes that from the critical
path by pretending to be Exotel against our own service.

```bash
pnpm --filter @msva/telephony sim -- --audio caller.wav
```

It performs the `connected` and `start` handshake, streams a WAV down the
socket as 20 ms base64 media frames at wall-clock speed, honours `clear` for
barge-in, sends `stop`, and writes whatever the agent said to a WAV you can
play.

Useful flags:

| Flag | Meaning |
|---|---|
| `--audio <wav>` | Caller speech. Any sample rate or channel count; converted to 8 kHz mono. |
| `--trailing-silence <ms>` | Pause after the speech. Without it the endpointer never fires. |
| `--silence <ms>` | With no `--audio`, how long the caller stays quiet. |
| `--out <wav>` | Where to write the agent's audio. |
| `--url <ws>` | Defaults to the local service. |

It reports two latencies, and the difference matters. **First audio** is how
long the caller waited from dialling before hearing anything. **Reply latency**
is measured from the moment the caller stopped talking, which is the number the
proposal sells.

### What a green run does and does not prove

It proves our framing, endpointing, barge-in, recognition, agent and speech
output work together over the real message shapes. It does not prove Exotel's
live edge behaves as documented, and it exercises none of the real network
jitter or codec artefacts. Treat it as "our side is correct", not "the
integration works".

### It has already earned its keep

Serving the greeting from cache emitted fifteen seconds of audio in one burst.
The pipeline treats "still emitting" as "still talking" and only allows
barge-in while that holds, so the agent was marked silent long before the
caller stopped hearing it, and interruptions during the greeting were dropped.
The simulator showed zero barge-in events where there should have been one.
Playback is now paced, and a test pins that behaviour.
