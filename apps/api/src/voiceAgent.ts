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
// This is the startup default; it can be flipped at runtime via the API
// (/api/voice-agent/llm-mode) so a presenter can switch from the app, no SSH.
let llmEnabled = (process.env.AGENT_LLM ?? "on").toLowerCase() !== "off";

export function getLlmEnabled(): boolean {
  return llmEnabled;
}
export function setLlmEnabled(value: boolean): void {
  llmEnabled = value;
}

// LLM provider: "ollama" (local, default) or "anthropic" (hosted Claude — fast
// even on a CPU box). Set LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY to use it.
const llmProvider = (process.env.LLM_PROVIDER ?? "ollama").toLowerCase();
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const anthropicModel = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const anthropicTimeoutMs = Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 20000);
const usingAnthropic = llmProvider === "anthropic" && Boolean(anthropicKey);

export function getActiveModel(): string {
  return usingAnthropic ? anthropicModel : defaultModel;
}

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
          "Namaste, main Madhusudan ki AI assistant hoon. Kaise madad kar sakti hoon?",
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
    outcome: state.outcome === "ticket_created" && state.collected.ticketId ? "ticket_created" : "in_progress",
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
  const acceptedMention = (match: RegExpMatchArray) =>
    !/^\s*(?:nahi\b|nahin\b|not\b|नहीं)/i.test(message.slice(match.index! + match[0].length));
  const places = [...message.matchAll(/\b(ghaziabad|delhi|noida|meerut|gurgaon|gurugram|faridabad|lucknow|kanpur|agra|aligarh|moradabad)\b/gi)].filter(acceptedMention);
  if (places.length) next.collected.location = places.at(-1)![0];
  // The latest mention wins, including "paneer nahi, dahi" corrections.
  const products = [
    { name: "milk", pattern: /\b(milk|full cream|tea special|double toned|uht|elaichi|kesar badam)\b/gi },
    { name: "ghee", pattern: /\b(ghee|poly pack|ceka pack)\b/gi },
    { name: "dahi", pattern: /\b(dahi|curd|yogurt|magic)\b/gi },
    { name: "paneer", pattern: /\b(paneer|cottage cheese)\b/gi },
    { name: "butter", pattern: /\b(butter|chiplet|makkhan)\b/gi },
    { name: "specialty", pattern: /\b(gulab jamun|fresh cream|chaach|chaas|dairy whitener)\b/gi }
  ].flatMap(({ name, pattern }) => [...message.matchAll(pattern)].filter(acceptedMention).map((match) => ({ name, index: match.index })))
    .sort((left, right) => left.index - right.index);
  if (products.length) next.collected.product = products.at(-1)!.name;
  if (/\b(agent|insaan|human|senior|manager|baat karwao|baat karwa)\b/i.test(text)) {
    next.escalationReason = "Caller requested human support.";
  }

  if (next.call.intent === "product_complaint" && next.call.urgency === "high") {
    next.escalationReason = "Food quality or safety complaint should be escalated.";
  } else if (next.call.intent === "invoice_payment") {
    next.escalationReason = "Payment or invoice dispute needs manual validation.";
  }

  return next;
}

// What the caller actually said on this call, newest last — the honest source
// for a ticket summary. Falls back to the profile seed only when nothing has
// been said yet (e.g. a scripted demo persona).
function callerSummary(state: ConversationState): string {
  const said = state.messages
    .filter((m) => m.role === "caller")
    .map((m) => m.text.trim())
    .filter((t) => t && !t.startsWith("["));
  if (said.length === 0) return state.call.transcriptSeed;
  return said.slice(-3).join(" | ").slice(0, 500);
}

// Remember what a tool gave back so the spoken reply can quote it (ticket
// number, order status) instead of inventing a placeholder.
function applyToolResult(state: ConversationState, result: ToolResult): void {
  if (!result.ok || !result.data || typeof result.data !== "object") return;
  const data = result.data as Record<string, unknown>;
  if (result.name === "create_ticket" && typeof data.ticketId === "string") {
    state.collected.ticketId = data.ticketId;
  }
  if (result.name === "lookup_order" && data.found === true && typeof data.status === "string") {
    state.collected.orderStatus = data.status;
    if (typeof data.eta === "string") state.collected.orderEta = data.eta;
  }
}

const providerRetryReply = "Maaf kijiye, abhi jawab dene mein dikkat aa rahi hai. Ek baar phir koshish karein?";
const providerUnavailableReply = "Maaf kijiye, abhi bhi jawab dene mein dikkat aa rahi hai. Thodi der baad dobara call kijiye.";

function providerFailureReply(state: ConversationState): string {
  const repeated = state.messages.some((message) => message.role === "assistant" &&
    (message.text === providerRetryReply || message.text === providerUnavailableReply));
  return repeated ? providerUnavailableReply : providerRetryReply;
}

function fallbackReply(state: ConversationState): string {
  if (state.collected.ticketId) {
    return `Aapki request ka ticket ${state.collected.ticketId} hai. Aur kis baat mein madad chahiye?`;
  }
  if (state.call.intent === "delivery_delay" || state.call.intent === "order_status") {
    return "Aapka order ya invoice number kya hai?";
  }
  if (state.call.intent === "product_complaint") {
    return state.collected.product ? "Packet par batch number kya likha hai?" : "Kis product mein dikkat hai?";
  }
  if (state.call.intent === "invoice_payment") return "Aapka invoice number kya hai?";
  if (!state.collected.product) return "Kis baat mein madad chahiye?";
  if (!state.collected.location) return "Aapko kis area mein chahiye?";
  return "Abhi live stock confirm nahi kar sakti hoon.";
}

// Speak only confirmed results, without a second model pass that could turn a
// failed integration into a promise. At most two results are spoken per turn.
function toolReply(results: ToolResult[]): string {
  const lines = results.map((result) => {
    const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    if (!result.ok) {
      switch (result.name) {
        case "create_ticket": return "Maaf kijiye, abhi ticket save nahi ho paya.";
        case "transfer_to_human": return "Maaf kijiye, abhi human support se connect nahi kar sakti hoon.";
        case "check_inventory": return "Abhi live stock ki availability confirm nahi kar sakti hoon.";
        case "send_whatsapp_confirmation": return "Maaf kijiye, WhatsApp message nahi bhej paayi hoon.";
        default: return "Maaf kijiye, abhi order ki jaankari nahi mil paayi.";
      }
    }
    if (result.name === "create_ticket" && typeof data.ticketId === "string") {
      return `Aapki request save ho gayi hai, ticket number ${data.ticketId} hai.`;
    }
    if (result.name === "lookup_order") {
      if (data.found === false) return "Is number par order nahi mila.";
      if (data.found === true && typeof data.status === "string") {
        const statuses: Record<string, string> = {
          out_for_delivery: "order delivery ke liye nikal chuka hai",
          scheduled: "order ki delivery schedule hai",
          invoice_open: "invoice ka kaam abhi pending hai",
          delivered: "order deliver ho chuka hai"
        };
        const status = statuses[data.status] ?? `status ${data.status.replaceAll("_", " ")} hai`;
        const detail = data.status !== "delivered" && typeof data.eta === "string" && data.eta
          ? `, record mein ${data.eta}` : "";
        return `Order record ke mutabik ${status}${detail}.`;
      }
    }
    if (result.name === "check_inventory" && typeof data.available === "boolean") {
      return data.available ? "Stock record mein product available hai." : "Stock record mein product available nahi hai.";
    }
    return "Abhi is action ki confirmation nahi mili hai.";
  });
  // Keep a saved ticket reference alongside any failed follow-up action.
  const saved = results.findIndex((result) => result.name === "create_ticket" && result.ok);
  const failed = results.findIndex((result) => !result.ok);
  const indices = [...new Set([saved, failed, ...results.map((_, index) => index)])].filter((index) => index >= 0);
  return indices.slice(0, 2).map((index) => lines[index]).join(" ");
}

// Direct model text is bounded before yielding to TTS. Confirmations use
// toolReply instead, so common unsupported action claims never reach speech.
function directModelReply(text: string, state: ConversationState): string {
  const cleaned = text.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim()
    .replace(/\bsamajh gaya\b/gi, "samajh gayi")
    .replace(/\bkar sakta hoon\b/gi, "kar sakti hoon")
    .replace(/\bkar raha hoon\b/gi, "kar rahi hoon");
  const phone = state.call.phone.replace(/\D/g, "");
  const sentences = cleaned.match(/[^.!?।]+[.!?।]+|[^.!?।]+$/g) ?? [];
  const spoken: string[] = [];
  let questionAsked = false;
  for (const raw of sentences) {
    const sentence = raw.trim();
    const references = sentence.match(/\bTKT-\d+\b/gi) ?? [];
    if (references.some((reference) => reference !== state.collected.ticketId)) {
      return "Abhi ticket ki confirmation nahi mili hai.";
    }
    if (phone.length >= 8 && sentence.replace(/\D/g, "").includes(phone)) continue;
    const action = /\b(ticket|request|transfer|connect|whatsapp|sms|message|forward|callback|call back|stock|availability)\b|टिकट|ट्रांसफर|मैसेज|स्टॉक/i.test(sentence);
    if (action) {
      const claims = sentence.matchAll(/\b(created|saved|registered|sent|queued|available|confirmed|scheduled|transferred|connected|will|kar diy[ai]|kar di|bana diy[ai]|kar rah[ai]|bhej|karegi|karega|karungi|ho gay[ai]|ho jayega)\b|बना दिया|कर दिया|भेज दिया|कर रही|करेगी|उपलब्ध/gi);
      for (const claim of claims) {
        // A question at the end or an unrelated "nahi" does not negate an
        // earlier assertion. Only negation next to this action can do that.
        const before = sentence.slice(0, claim.index);
        const after = sentence.slice(claim.index! + claim[0].length);
        const deniedBefore = /(?:\b(?:nahi|nahin|not|no|cannot|can't|unable|unavailable)|नहीं)(?:\s+\w+){0,2}\s*$/i.test(before);
        const deniedAfter = /^\s+(?:(?:nahi|nahin|not)\b|नहीं)/i.test(after);
        if (!deniedBefore && !deniedAfter) return "Abhi is action ki confirmation nahi mili hai.";
      }
    }
    if (sentence.endsWith("?")) {
      if (questionAsked) break;
      questionAsked = true;
    }
    spoken.push(sentence);
    if (spoken.length === 2) break;
  }
  const reply = spoken.join(" ");
  return reply.split(/\s+/).length > 45 ? spoken[0]!.split(/\s+/).slice(0, 45).join(" ").replace(/[.!?,:;]$/, "") + "." : reply;
}

// ---------------------------------------------------------------------------
// Ollama chat client (with native function-calling)
//
// One decision call returns either a short reply or requested tools. Tool
// results receive deterministic spoken confirmations. Provider failures get a
// brief retry/unavailable reply and never launch guessed actions.
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
    "Speak as one warm, respectful female AI assistant. Use consistent feminine Hindi phrasing: kar sakti hoon, samajh gayi. Never pretend to be human.",
    "Catalog you can talk about: Cow Milk, Toned Milk, Full Cream Milk, Tea Special Milk, Double Toned Milk, UHT Milk; Desi Ghee in Tin / Bucket / Jar / Poly Pack / Ceka Pack; Dahi Lite and Dahi Magic (cup + jar); Fresh Paneer; Butter and Butter Chiplet; Chaach; Gulab Jamun Mix (Pouch + Ziplock); Flavored Milk in Elaichi / Kesar Badam / Coffee; Fresh Cream 200 ml + 1 L; Dairy Whitener.",
    "Respond only in natural Hinglish, using Devanagari only if the caller does.",
    "Use 1-2 short spoken sentences, usually under 35 words, with at most one question. No emojis, markdown, taglines, marketing copy, or catalog lists unless requested.",
    "Read the conversation before replying. Reuse details already given, accept the caller's latest correction over older details, and ask only the next missing question. Never repeat a generic availability question or the greeting.",
    "Use tools before reporting an action. lookup_order reads a seeded order record, not a live ERP feed; describe it as the order record. create_ticket saves to the support queue. Inventory, WhatsApp and human transfer are currently unavailable; never claim stock, a sent message or a completed handoff.",
    "Only claim an action succeeded after a successful tool result. A failure is not completion. Never invent ticket IDs, callbacks, callback deadlines, SMS, forwarding, availability or ETAs. Never read out the caller's phone number. Do not create another ticket when one is already recorded unless the caller explicitly requests a separate issue.",
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
      description: "Read seeded delivery/order/invoice records by order or invoice number, or by caller phone.",
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
      description: "Request product availability for an area; currently returns unavailable because no inventory provider is connected.",
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
      description: "Save a support request to the built-in ticket queue; no callback time is guaranteed.",
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
      description: "Request a human transfer; currently returns unavailable because no telephony handoff is connected.",
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
      description: "Request WhatsApp confirmation; currently returns unavailable because no messaging provider is connected.",
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

// Same tools, in Anthropic's schema shape.
const ANTHROPIC_TOOLS = TOOL_SCHEMAS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters
}));

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

// ---------------------------------------------------------------------------
// Anthropic (hosted Claude) client — fast tool-calling agent. Used when
// LLM_PROVIDER=anthropic. One decision call (with tools); if Claude calls a
// tool we execute it and speak the confirmed result.
// ---------------------------------------------------------------------------

type AnthropicBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };

async function anthropicRequest(system: string, messages: unknown[]): Promise<{ content?: AnthropicBlock[] } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), anthropicTimeoutMs);
  try {
    const response = await fetch(`${anthropicBaseUrl}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": anthropicKey as string,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: anthropicModel, max_tokens: 400, system, tools: ANTHROPIC_TOOLS, messages, stream: false })
    });
    if (!response.ok) {
      console.error("[anthropic] HTTP", response.status);
      return null;
    }
    // Keep the abort deadline active until the whole JSON body is consumed.
    return await response.json() as { content?: AnthropicBlock[] };
  } finally {
    clearTimeout(timeout);
  }
}

async function* anthropicAgent(
  systemPrompt: string,
  history: OllamaMessage[],
  nextState: ConversationState,
  callId: string,
  executed: ToolCall[]
): AsyncGenerator<ChatStreamEvent, { reply: string; used: boolean }, void> {
  const messages: Array<{ role: string; content: unknown }> = history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content
  }));

  let data: { content?: AnthropicBlock[] } | null;
  try {
    data = await anthropicRequest(systemPrompt, messages);
  } catch (error) {
    console.error("[anthropic] request failed", error);
    return { reply: "", used: false };
  }
  if (!data) return { reply: "", used: false };

  const blocks = data.content ?? [];
  const toolUses = blocks.filter((b) => b.type === "tool_use");
  const textOut = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  let reply = "";
  if (toolUses.length > 0) {
    const toolResults: ToolResult[] = [];
    for (const tu of toolUses) {
      const toolCall = normalizeToolCall(
        { id: tu.id ?? nextToolCallId(), name: (tu.name ?? "") as ToolName, args: tu.input ?? {} },
        nextState
      );
      yield { type: "tool_call", call: toolCall };
      const result = await dispatchTool(callId, toolCall);
      executed.push(toolCall);
      applyToolToOutcome(nextState, toolCall, result);
      applyToolResult(nextState, result);
      yield { type: "tool_result", result };
      toolResults.push(result);
    }
    reply = toolReply(toolResults);
    yield { type: "token", text: reply };
    return { reply, used: true };
  }

  if (textOut.trim()) {
    reply = directModelReply(textOut, nextState);
    yield { type: "token", text: reply };
    return { reply, used: true };
  }
  return { reply: "", used: false };
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
    if (!args.summary) args.summary = callerSummary(state);
    if (!args.priority) args.priority = state.call.urgency;
  }
  if (call.name === "transfer_to_human") {
    if (!args.reason) args.reason = state.escalationReason ?? "escalation";
    if (!args.summary) args.summary = `${state.call.callerName} (${state.call.phone}): ${state.collected.issue ?? state.call.intent}`;
  }
  return { ...call, args };
}

function applyToolToOutcome(state: ConversationState, call: ToolCall, result: ToolResult): void {
  if (!result.ok) return;
  const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
  if (call.name === "create_ticket" && typeof data.ticketId === "string") {
    state.outcome = "ticket_created";
  }
  if (call.name === "transfer_to_human" && data.transferred === true) {
    state.outcome = "human_transfer";
    if (!state.escalationReason) state.escalationReason = String(call.args.reason ?? "escalation");
  }
  if (call.name === "check_inventory" && typeof data.available === "boolean" && state.outcome === "in_progress") {
    state.outcome = "resolved_by_va";
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
// Explicit LLM-off demo mode only. Actions are derived from intent and known
// details; conversation outcomes change only after confirmed tool success.
// ---------------------------------------------------------------------------

function synthesizeToolCalls(state: ConversationState): ToolCall[] {
  if (state.call.intent === "delivery_delay" && !state.escalationReason && !state.collected.ticketId) {
    return [
      {
        id: nextToolCallId(),
        name: "create_ticket",
        args: {
          phone: state.call.phone,
          intent: state.call.intent,
          summary: callerSummary(state),
          priority: state.call.urgency
        }
      }
    ];
  }
  if (state.escalationReason || state.call.intent === "human_agent") {
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
  if (state.call.intent === "product_availability" && state.collected.product && state.collected.location) {
    return [
      {
        id: nextToolCallId(),
        name: "check_inventory",
        args: {
          sku: state.collected.product,
          area: state.collected.location
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
//   1. zero or more `tool_call` / `tool_result` pairs as tools execute,
//   2. a bounded `token` reply ready for TTS,
//   3. exactly one `final` event with the reply and new state.
// The REST endpoint collects the same events into a `ChatResponse`.
// ---------------------------------------------------------------------------

export async function* streamChat(
  callId: string,
  message: string,
  state?: ConversationState,
  sessionId?: string
): AsyncGenerator<ChatStreamEvent, void, void> {
  const call = findDemoCall(callId);
  // Tools receive the persisted call id when there is one, so a ticket created
  // mid-call links to the stored call rather than to the demo persona id.
  const toolCallId = sessionId ?? callId;
  const baseState = state ?? initialState(call);
  const nextState = inferState(baseState, message);

  const systemPrompt = buildSystemPrompt(nextState);
  const history = toOllamaHistory(nextState);
  const messages: OllamaMessage[] = [{ role: "system", content: systemPrompt }, ...history];

  let reply = "";
  let source: "ollama" | "anthropic" | "fallback" = "fallback";
  const executedToolCalls: ToolCall[] = [];

  try {
    // Pass 1: let the model decide whether to call a tool (unless LLM disabled).
    if (llmEnabled && usingAnthropic) {
      // Hosted Claude — fast tool-calling agent.
      const result = yield* anthropicAgent(systemPrompt, history, nextState, toolCallId, executedToolCalls);
      reply = result.reply;
      if (result.used) source = "anthropic";
    } else if (llmEnabled) {
      const decision = await ollamaComplete(messages, TOOL_SCHEMAS);

      if (decision && decision.toolCalls.length > 0) {
        source = "ollama";

        const toolResults: ToolResult[] = [];
        for (const rawCall of decision.toolCalls) {
          const toolCall = normalizeToolCall(rawCall, nextState);
          yield { type: "tool_call", call: toolCall };
          const result: ToolResult = await dispatchTool(toolCallId, toolCall);
          executedToolCalls.push(toolCall);
          applyToolToOutcome(nextState, toolCall, result);
          applyToolResult(nextState, result);
          yield { type: "tool_result", result };
          toolResults.push(result);
        }
        reply = toolReply(toolResults);
        yield { type: "token", text: reply };
      } else if (decision && decision.content.trim()) {
        // Model answered directly, no tool needed.
        source = "ollama";
        reply = directModelReply(decision.content, nextState);
        yield { type: "token", text: reply };
      }
    }
  } catch (error) {
    yield { type: "error", message: error instanceof Error ? error.message : "stream error" };
  }

  // Safety net: if the model produced no usable reply, fall back deterministically
  // so the demo never goes silent.
  if (!reply.trim()) {
    source = "fallback";
    const toolResults: ToolResult[] = [];
    if (!llmEnabled && executedToolCalls.length === 0) {
      source = "fallback";
      for (const synthCall of synthesizeToolCalls(nextState)) {
        yield { type: "tool_call", call: synthCall };
        const result: ToolResult = await dispatchTool(toolCallId, synthCall);
        executedToolCalls.push(synthCall);
        applyToolToOutcome(nextState, synthCall, result);
        applyToolResult(nextState, result);
        toolResults.push(result);
        yield { type: "tool_result", result };
      }
    }
    reply = toolResults.length ? toolReply(toolResults) : llmEnabled ? providerFailureReply(nextState) : fallbackReply(nextState);
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
    model: getActiveModel(),
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
  state?: ConversationState,
  sessionId?: string
): Promise<ChatResponse> {
  let response: ChatResponse | undefined;
  const toolCalls: ToolCall[] = [];

  for await (const event of streamChat(callId, message, state, sessionId)) {
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
      reply: providerFailureReply(fallback),
      state: fallback,
      model: defaultModel,
      source: "fallback",
      toolCalls
    };
  }
  return response;
}
