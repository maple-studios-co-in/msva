# Call quality update

This update addresses the repeated availability reply heard during an Exotel
test call, lost or overlapping speech, and the need to refresh the console to
see new transcript turns.

## Caller experience

- The assistant opens with: “Namaste, main Madhusudan ki AI assistant hoon.
  Kaise madad kar sakti hoon?” Fixed prompts use the same female voice.
- Replies use one or two short sentences and at most one question. The prompt
  asks the assistant to remember supplied details and corrections.
- A model outage produces a short retry message, then an unavailable message
  if it continues. It does not invent an availability check or launch guessed
  business actions.
- Confirmations come from tool results. A ticket is confirmed only after it
  is saved. Unconnected stock, WhatsApp and human-transfer integrations report
  unavailable; they do not claim success or promise a callback.
- TTS requests play in order, and the completion marker follows all audio.
  Recognition splits long speech into requests below the provider limit,
  ignores idle audio and reports failures separately from caller words.
- Each call has a bounded pending-turn queue so a final utterance arriving
  during another response is not silently discarded.

## Browser console

Open `/console.html#/calls` and select the current call. The list refreshes
every five seconds and an active call detail refreshes every 2.5 seconds.
Background tabs pause polling and resume when visible. Completed calls stop
detail polling. Stored transcripts remain visible during refreshes and errors
are shown. Ticket and user editing screens retain their existing behaviour.

This displays stored transcript turns; it does not provide a live phone-audio
player. The public browser microphone demo remains a separate call channel.

## Validation and limits

Regression tests use synthetic audio, mocked provider responses and a mocked
database boundary. They cover ordering, cancellation, long speech, provider
errors, queued turns, truthful action results and console polling lifecycle.
Run `pnpm test`, `pnpm -r typecheck` and `pnpm -r build` with Node 22 or newer.

The order lookup still uses the seeded `data/orders.json` snapshot. ERP/live
inventory, WhatsApp delivery, provider-backed human transfer and email delivery
of console sign-in codes remain separate integrations. This update does not
make those integrations available or establish carrier call quality under
load. A real Exotel call remains the final check for turn-taking on the phone.
