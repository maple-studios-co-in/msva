# Agent streaming

How `streamChat` works, what events it emits, and how the REST endpoint, the SSE endpoint, and the telephony service all consume the same generator.

## The contract

`streamChat(callId, message, state?)` is the single entry point for one caller turn. It's an async generator that yields a sequence of `ChatStreamEvent`s:

```ts
type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; result: ToolResult }
  | {
      type: "final";
      reply: string;
      state: ConversationState;
      model: string;
      source: "ollama" | "fallback";
      toolCalls: ToolCall[];
    }
  | { type: "error"; message: string };
```

Guarantees:

- Exactly one `final` event per call, always last.
- Zero or more `token` events, in order, concatenating to the final `reply`.
- Tool calls and their matching results come as adjacent pairs (`tool_call` then `tool_result`).
- If Ollama is unavailable, the generator emits the deterministic fallback as a single `token` event before the `final`.

## Three consumers, one generator

```
                  apps/api / voiceAgent.ts
                      streamChat()
                          │
        ┌─────────────────┼──────────────────────┐
        ▼                 ▼                      ▼
  handleChat()      POST /chat/stream      apps/telephony
   (REST, drain     (SSE, forward             (in-process call
    into single      each event as              via SSE; pipes
    ChatResponse)    `data: <json>\n\n`)        token deltas into
                                                streaming TTS)
```

The browser demo today uses `handleChat()` via `POST /api/voice-agent/chat`. To get token-by-token replies in the dashboard, switch the client to consume `POST /api/voice-agent/chat/stream` with `EventSource` or `fetch` + a reader loop. The telephony service uses the SSE endpoint over HTTP (see `apps/telephony/src/agentClient.ts`) which keeps the two services independently deployable.

## Inside the generator

The sequence inside one turn:

1. **State inference** — `inferState()` mutates `collected` and `outcome` based on regex hits in the caller message. Cheap pre-LLM signal that drives tool synthesis.
2. **Streaming Ollama** — POST `/api/chat` with `stream: true`, parse the NDJSON response line-by-line, and yield each `message.content` delta as a `token` event.
3. **Fallback** — if no tokens arrived (Ollama down, timed out, or returned empty), yield the deterministic `fallbackReply()` as one big `token`.
4. **Tool synthesis** — `synthesizeToolCalls(state)` derives 0–N `ToolCall`s from the inferred outcome. For each one, yield `tool_call`, `await dispatchTool()`, yield `tool_result`.
5. **Final** — assemble the full reply, append the new assistant message to state, yield `final`.

## Tools

Tools live in `apps/api/src/tools/`. Each tool exports an async function with a typed `args` shape and returns a `ToolResult`. `dispatchTool(callId, call)` is the single switchboard.

### Adding a new tool

1. Define the tool name in `packages/shared/src/index.ts`:

   ```ts
   export type ToolName =
     | "lookup_order"
     | "create_ticket"
     // ...
     | "my_new_tool";
   ```

2. Implement the handler in a file under `apps/api/src/tools/`:

   ```ts
   export type MyNewToolArgs = { foo: string };

   export async function myNewTool(callId: string, args: MyNewToolArgs): Promise<ToolResult> {
     // call your service…
     return { id: callId, name: "my_new_tool", ok: true, data: { /* … */ } };
   }
   ```

3. Wire it into `dispatchTool` in `tools/index.ts`.

4. Decide when it fires. Two options:
   - **Deterministic** — add a branch in `synthesizeToolCalls()` in `voiceAgent.ts`. Use this when the trigger is a clear state predicate.
   - **LLM-emitted** — once the model is upgraded to one with reliable native tool calling, parse JSON tool calls out of the streamed content. Track this in the [calling roadmap](./calling-roadmap.md) Phase 2.

5. If the tool has a telephony-side effect (warm transfer, queueing a hangup, sending DTMF), the pipeline in `apps/telephony/src/pipeline.ts` listens for `tool_result` events. Add a case in `handleToolResult()` there.

## Why streaming matters

A non-streaming agent waits for the LLM to finish, then waits for TTS to synthesize the full reply, then plays it. Latency stacks:

```
ASR  300ms │
LLM       1200ms │
TTS                400ms │
WAV                       200ms │
─────────────────────────────────────► 2.1s before the caller hears anything
```

A streaming agent starts TTS at the first token (or first sentence boundary), so the caller hears the reply within ~700ms even though total generation takes longer. The same shape applies for tool results — they're emitted as soon as the tool returns, so the dashboard can render "ticket created" before the LLM's natural-language confirmation finishes.
