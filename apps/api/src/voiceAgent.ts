import type {
  ChatResponse,
  ChatStreamEvent,
  ConversationState,
  DemoCall,
  ToolCall,
  ToolName,
  ToolResult
} from "@msva/shared";
import { findDemoCall } from "./demoCalls.js";
import { dispatchTool, nextToolCallId } from "./tools/index.js";

const defaultModel = process.env.OLLAMA_MODEL ?? "qwen3.5:4b";
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const ollamaTimeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? 6000);
// Set AGENT_LLM=off to bypass Ollama entirely and use the instant deterministic
// replies + heuristic tool calls. Handy for a snappy live demo on a CPU-only box.
const llmEnabled = (process.env.AGENT_LLM ?? "on").toLowerCase() !== "off";

function now(): string {
  return new Date().toISOString();
}

export function initialState(call: DemoCall): ConversationState {
  return {
    call,
    collected: {},
    outcome: "in_progress",
    messages: [
      {
        role: "assistant",
        text:
          "Namaste, Madhusudan family se baat ho rahi hai. Main AI assistant hoon. Bataiye, milk, ghee, dahi, paneer ya kisi aur product ke baare mein call hai?",
        timestamp: now()
      },
      {
        role: "system",
        text: call.transcriptSeed,
        timestamp: now()
      }
    ]
  };
}

function inferState(state: ConversationState, message: string): ConversationState {
  const next: ConversationState = {
    ...state,
    collected: { ...state.collected },
    messages: [
      ...state.messages,
      { role: "caller", text: message, timestamp: now() }
    ]
  };

  const text = message.toLowerCase();
  if (/\b(batch|expiry|smell|kharab|quality|packet|rubbery|sour|mold)\b/i.test(text)) {
    next.collected.issue = "product quality complaint";
  }
  if (/\b(order|invoice|bill|payment|credit|adjust|due)\b/i.test(text)) {
    next.collected.reference = message;
  }
  if (/\b(ghaziabad|delhi|noida|meerut|gurgaon|gurugram|faridabad|lucknow|kanpur|agra|aligarh|moradabad)\b/i.test(text)) {
    next.collected.location = message;
  }
  // Madhusudan SKU recognition — catch the most common product mentions.
  if (/\b(cow milk|toned milk|full cream|tea special|double toned|uht|flavored milk|elaichi|kesar badam)\b/i.test(text)) {
    next.collected.product = "milk";
  }
  if (/\b(desi ghee|ghee tin|ghee bucket|ghee jar|poly pack|ceka pack)\b/i.test(text)) {
    next.collected.product = "ghee";
  }
  if (/\b(dahi|curd|yogurt|magic|dahi lite|dahi magic)\b/i.test(text)) {
    next.collected.product = "dahi";
  }
  if (/\b(paneer|cottage cheese|fresh paneer)\b/i.test(text)) {
    next.collected.product = "paneer";
  }
  if (/\b(butter|chiplet|makkhan)\b/i.test(text)) {
    next.collected.product = "butter";
  }
  if (/\b(gulab jamun|fresh cream|chaach|chaas|dairy whitener)\b/i.test(text)) {
    next.collected.product = "specialty";
  }
  if (/\b(agent|insaan|human|senior|manager|baat karwao|baat karwa)\b/i.test(text)) {
    next.outcome = "human_transfer";
    next.escalationReason = "Caller requested human support.";
  }

  if (next.call.intent === "product_complaint" && next.call.urgency === "high") {
    next.outcome = "human_transfer";
    next.escalationReason = "Food quality or safety complaint should be escalated.";
  } else if (next.call.intent === "invoice_payment") {
    next.outcome = "human_transfer";
    next.escalationReason = "Payment or invoice dispute needs manual validation.";
  } else if (next.call.intent === "delivery_delay") {
    next.outcome = "ticket_created";
  } else if (next.call.intent === "product_availability" && Object.keys(next.collected).length >= 1) {
    next.outcome = "resolved_by_va";
  }

  return next;
}

function fallbackReply(state: ConversationState): string {
  const { intent } = state.call;

  if (state.outcome === "human_transfer") {
    return `Bilkul samajh gaya. Is case ko main Madhusudan ki human support team ko transfer kar raha hoon. Summary unke paas pahunch jayegi: caller ${state.call.callerName}, issue ${state.collected.issue ?? intent}, phone ${state.call.phone}. Kripya line par rahiye.`;
  }
  if (state.outcome === "ticket_created") {
    return `Theek hai. Maine aapki request register kar di hai. Ticket MS-${state.call.phone.slice(-4)} ban gaya hai. Madhusudan ki team delivery status check karke 30 minute ke andar callback karegi.`;
  }
  if (state.outcome === "resolved_by_va") {
    return "Theek hai. Aapke area ke liye Dahi Magic aur Dahi Lite ki availability note kar li hai. Distributor ko aaj evening tak request forward ho jayegi, aur confirmation SMS bhej diya jayega.";
  }
  if (intent === "delivery_delay") {
    return "Order ya invoice number bata dijiye. Agar number na ho to delivery area, product (Desi Ghee, Paneer, ya jo bhi ho), aur expected date bata dijiye — main turant ticket register kar deta hoon.";
  }
  if (intent === "product_complaint") {
    return "Mujhe product name (Cow Milk, Paneer, Dahi etc.), pack size, batch number, aur expiry date bata dijiye, aur aapka area bhi. Food quality serious matter hai, isliye details leke priority par escalate karunga.";
  }
  if (intent === "invoice_payment") {
    return "Distributor code, invoice number, aur amount bata dijiye. Main details capture karke accounts team ko warm-transfer karunga taaki adjustment ho sake.";
  }
  return "Product name, quantity aur area bata dijiye. Main Madhusudan ke catalog mein availability check karke next step confirm karta hoon.";
}

// ---------------------------------------------------------------------------
// Ollama chat client (with native function-calling)
//
// Two entry points:
//   • ollamaComplete(messages, tools) — non-streaming. Returns the assistant
//     message so we can inspect `tool_calls`. This is the "decide what to do"
//     pass.
//   • ollamaStream(messages)          — streaming NDJSON. Yields content
//     deltas for the spoken reply (the "say it" pass), grounded in any tool
//     results we appended to the thread.
//
// If Ollama is unreachable or times out, both return empty and the caller
// falls back to deterministic replies + heuristic tool synthesis so the demo
// never breaks.
// ---------------------------------------------------------------------------

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: unknown[];
};

type OllamaToolCall = { function: { name: string; arguments: Record<string, unknown> | string } };

function buildSystemPrompt(state: ConversationState): string {
  return [
    "You are the Madhusudan inbound dairy voice agent (brand: Madhusudan, legal entity: Creamy Foods Ltd).",
    "Brand voice: warm, family-like, respectful. Tagline cue: 'Sealed with care. Delivered with love. Always Madhusudan.'",
    "Catalog you can talk about: Cow Milk, Toned Milk, Full Cream Milk, Tea Special Milk, Double Toned Milk, UHT Milk; Desi Ghee in Tin / Bucket / Jar / Poly Pack / Ceka Pack; Dahi Lite and Dahi Magic (cup + jar); Fresh Paneer; Butter and Butter Chiplet; Chaach; Gulab Jamun Mix (Pouch + Ziplock); Flavored Milk in Elaichi / Kesar Badam / Coffee; Fresh Cream 200 ml + 1 L; Dairy Whitener.",
    "Respond only in natural Hinglish, using Devanagari only if the caller does.",
    "Keep voice replies short: 1-3 sentences.",
    "Use the provided tools to take real action: call lookup_order for delivery/order/invoice status, check_inventory for availability, create_ticket to log a request, transfer_to_human to escalate, send_whatsapp_confirmation to confirm.",
    "When a tool returns data, base your reply ONLY on that data. Never invent order status, ETAs, or batch info. If a lookup returns found=false, say so and offer to create a ticket.",
    "Escalate food-quality / safety complaints, payment disputes, angry callers, or explicit human-agent requests via transfer_to_human.",
    `Caller phone on file: ${state.call.phone}. Use it as the phone argument when a tool needs one and the caller hasn't given another.`,
    `Call profile: ${JSON.stringify(state.call)}.`,
    `Collected fields: ${JSON.stringify(state.collected)}.`,
    `Current outcome: ${state.outcome}. Escalation reason: ${state.escalationReason ?? "none"}.`
  ].join(" ");
}

// Tool schemas advertised to the model (Ollama / OpenAI function format).
const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "lookup_order",
      description: "Look up live delivery/order/invoice status by order or invoice number, or by caller phone.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "Caller phone (digits)." },
          reference: { type: "string", description: "Order or invoice number if the caller gave one." }
        },
        required: ["phone"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_inventory",
      description: "Check product availability for an area.",
      parameters: {
        type: "object",
        properties: {
          sku: { type: "string", description: "Product / SKU, e.g. 'Dahi Magic 400g'." },
          area: { type: "string", description: "Delivery area, e.g. 'Ghaziabad'." }
        },
        required: ["sku", "area"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_ticket",
      description: "Log a support request for follow-up / callback.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string" },
          intent: { type: "string" },
          summary: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high"] }
        },
        required: ["phone", "summary"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "transfer_to_human",
      description: "Warm-transfer the caller to a human queue for escalations.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
          summary: { type: "string" },
          queue: { type: "string", enum: ["complaints", "accounts", "sales", "general"] }
        },
        required: ["reason", "summary"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_whatsapp_confirmation",
      description: "Queue a WhatsApp confirmation message to the caller.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string" },
          template: { type: "string" },
          vars: { type: "object" }
        },
        required: ["phone", "template"]
      }
    }
  }
];

type CompletePass = {
  content: string;
  toolCalls: ToolCall[];
  rawToolCalls: unknown[];
};

async function ollamaComplete(
  messages: OllamaMessage[],
  tools: unknown[]
): Promise<CompletePass | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ollamaTimeoutMs);
  try {
    const response = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: defaultModel,
        stream: false,
        think: false,
        tools,
        messages,
        options: { temperature: 0.2, num_predict: 200 }
      })
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      message?: { content?: string; tool_calls?: OllamaToolCall[] };
    };
    const rawToolCalls = json.message?.tool_calls ?? [];
    const toolCalls: ToolCall[] = rawToolCalls
      .map((raw) => {
        const name = raw?.function?.name as ToolName | undefined;
        if (!name) return null;
        let args: Record<string, unknown> = {};
        const rawArgs = raw.function.arguments;
        if (typeof rawArgs === "string") {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = {};
          }
        } else if (rawArgs && typeof rawArgs === "object") {
          args = rawArgs;
        }
        return { id: nextToolCallId(), name, args };
      })
      .filter((value): value is ToolCall => value !== null);
    return { content: json.message?.content ?? "", toolCalls, rawToolCalls };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function* ollamaStream(messages: OllamaMessage[]): AsyncGenerator<string, void, void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ollamaTimeoutMs);

  let response: Response;
  try {
    response = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: defaultModel,
        stream: true,
        think: false,
        messages,
        options: { temperature: 0.35, num_predict: 160 }
      })
    });
  } catch {
    clearTimeout(timeout);
    return;
  }

  if (!response.ok || !response.body) {
    clearTimeout(timeout);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          const delta = parsed.message?.content;
          if (delta) yield delta;
          if (parsed.done) return;
        } catch {
          // Ignore partial / malformed lines.
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

// Fill in obvious argument defaults the small model tends to omit, and map a
// decisive tool to the conversation outcome shown on the dashboard.
function normalizeToolCall(call: ToolCall, state: ConversationState): ToolCall {
  const args = { ...call.args };
  if (call.name === "lookup_order" || call.name === "create_ticket" || call.name === "send_whatsapp_confirmation") {
    if (!args.phone || String(args.phone).trim() === "") args.phone = state.call.phone;
  }
  if (call.name === "lookup_order" && !args.reference && state.collected.reference) {
    args.reference = state.collected.reference;
  }
  if (call.name === "create_ticket") {
    if (!args.intent) args.intent = state.call.intent;
    if (!args.summary) args.summary = state.collected.reference ?? state.call.transcriptSeed;
    if (!args.priority) args.priority = state.call.urgency;
  }
  if (call.name === "transfer_to_human") {
    if (!args.reason) args.reason = state.escalationReason ?? "escalation";
    if (!args.summary) args.summary = `${state.call.callerName} (${state.call.phone}): ${state.collected.issue ?? state.call.intent}`;
  }
  return { ...call, args };
}

function applyToolToOutcome(state: ConversationState, call: ToolCall): void {
  if (call.name === "create_ticket" && state.outcome === "in_progress") {
    state.outcome = "ticket_created";
  }
  if (call.name === "transfer_to_human") {
    state.outcome = "human_transfer";
    if (!state.escalationReason) state.escalationReason = String(call.args.reason ?? "escalation");
  }
}

function toOllamaHistory(state: ConversationState): OllamaMessage[] {
  return state.messages
    .filter((message) => message.role !== "system")
    .slice(-8)
    .map((message) => ({
      role: message.role === "caller" ? "user" : "assistant",
      content: message.text
    }));
}

// ---------------------------------------------------------------------------
// Tool-call synthesis
//
// The qwen3.5:4b checkpoint is unreliable at native function calling, so for
// the skeleton we derive tool calls deterministically from the inferred
// outcome. Once the LLM is upgraded (or the prompt is tuned to emit JSON
// tool calls) this function gets replaced by a parser over the model output.
// ---------------------------------------------------------------------------

function synthesizeToolCalls(state: ConversationState): ToolCall[] {
  if (state.outcome === "ticket_created") {
    return [
      {
        id: nextToolCallId(),
        name: "create_ticket",
        args: {
          phone: state.call.phone,
          intent: state.call.intent,
          summary: state.collected.reference ?? state.call.transcriptSeed,
          priority: state.call.urgency
        }
      }
    ];
  }
  if (state.outcome === "human_transfer") {
    return [
      {
        id: nextToolCallId(),
        name: "transfer_to_human",
        args: {
          reason: state.escalationReason ?? "escalation",
          summary: `${state.call.callerName} (${state.call.phone}): ${state.collected.issue ?? state.call.intent}`,
          queue:
            state.call.intent === "invoice_payment"
              ? "accounts"
              : state.call.intent === "product_complaint"
                ? "complaints"
                : "general"
        }
      }
    ];
  }
  if (state.outcome === "resolved_by_va" && state.call.intent === "product_availability") {
    return [
      {
        id: nextToolCallId(),
        name: "check_inventory",
        args: {
          sku: state.collected.product ?? "lassi+dahi",
          area: state.collected.location ?? "unknown"
        }
      }
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// streamChat — primary entry point
//
// Yields a sequence of events for one caller turn:
//   1. zero or more `token` events with incremental reply text (Ollama path),
//   2. zero or more `tool_call` / `tool_result` pairs as tools execute,
//   3. exactly one `final` event with the assembled reply + new state.
//
// The telephony pipeline pipes the `token` stream straight into TTS so audio
// playback begins before generation finishes. The REST endpoint just
// collects everything into a `ChatResponse`.
// ---------------------------------------------------------------------------

export async function* streamChat(
  callId: string,
  message: string,
  state?: ConversationState
): AsyncGenerator<ChatStreamEvent, void, void> {
  const call = findDemoCall(callId);
  const baseState = state ?? initialState(call);
  const nextState = inferState(baseState, message);

  const messages: OllamaMessage[] = [
    { role: "system", content: buildSystemPrompt(nextState) },
    ...toOllamaHistory(nextState)
  ];

  let reply = "";
  let source: "ollama" | "fallback" = "fallback";
  const executedToolCalls: ToolCall[] = [];

  try {
    // Pass 1: let the model decide whether to call a tool (unless LLM disabled).
    const decision = llmEnabled ? await ollamaComplete(messages, TOOL_SCHEMAS) : null;

    if (decision && decision.toolCalls.length > 0) {
      source = "ollama";
      messages.push({ role: "assistant", content: decision.content, tool_calls: decision.rawToolCalls });

      for (const rawCall of decision.toolCalls) {
        const toolCall = normalizeToolCall(rawCall, nextState);
        yield { type: "tool_call", call: toolCall };
        const result: ToolResult = await dispatchTool(callId, toolCall);
        executedToolCalls.push(toolCall);
        applyToolToOutcome(nextState, toolCall);
        yield { type: "tool_result", result };
        messages.push({
          role: "tool",
          content: JSON.stringify(result.ok ? result.data ?? { ok: true } : { error: result.error })
        });
      }

      // Pass 2: stream the spoken reply, now grounded in the tool results.
      for await (const token of ollamaStream(messages)) {
        reply += token;
        yield { type: "token", text: token };
      }
    } else if (decision && decision.content.trim()) {
      // Model answered directly, no tool needed.
      source = "ollama";
      reply = decision.content.trim();
      yield { type: "token", text: reply };
    }
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : "stream error" };
  }

  // Safety net: if the model produced no usable reply, fall back deterministically
  // so the demo never goes silent.
  if (!reply.trim()) {
    if (executedToolCalls.length === 0) {
      source = "fallback";
      for (const synthCall of synthesizeToolCalls(nextState)) {
        yield { type: "tool_call", call: synthCall };
        const result: ToolResult = await dispatchTool(callId, synthCall);
        executedToolCalls.push(synthCall);
        applyToolToOutcome(nextState, synthCall);
        yield { type: "tool_result", result };
      }
    }
    reply = fallbackReply(nextState);
    yield { type: "token", text: reply };
  }

  const finalState: ConversationState = {
    ...nextState,
    messages: [
      ...nextState.messages,
      { role: "assistant", text: reply, timestamp: now() }
    ]
  };

  yield {
    type: "final",
    reply,
    state: finalState,
    model: defaultModel,
    source,
    toolCalls: executedToolCalls
  };
}

// ---------------------------------------------------------------------------
// handleChat — backward-compatible REST entry point
//
// Consumes the stream above and collapses it into the existing ChatResponse
// shape so the demo UI keeps working unchanged.
// ---------------------------------------------------------------------------

export async function handleChat(
  callId: string,
  message: string,
  state?: ConversationState
): Promise<ChatResponse> {
  let response: ChatResponse | undefined;
  const toolCalls: ToolCall[] = [];

  for await (const event of streamChat(callId, message, state)) {
    if (event.type === "tool_call") toolCalls.push(event.call);
    if (event.type === "final") {
      response = {
        reply: event.reply,
        state: event.state,
        model: event.model,
        source: event.source,
        toolCalls: event.toolCalls
      };
    }
  }

  if (!response) {
    // streamChat is guaranteed to emit a `final` event, but fall back to a
    // minimal response if something exotic happens (e.g. consumer throws).
    const fallback = inferState(state ?? initialState(findDemoCall(callId)), message);
    return {
      reply: fallbackReply(fallback),
      state: fallback,
      model: defaultModel,
      source: "fallback",
      toolCalls
    };
  }
  return response;
}
