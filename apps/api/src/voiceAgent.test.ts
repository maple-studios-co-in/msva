import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent, ConversationState, DemoCall, ToolName } from "@msva/shared";

// Only the database boundary and HTTP provider are replaced. Tool dispatch,
// ticket construction and conversation state all run their real implementations.
const db = vi.hoisted(() => ({
  ready: vi.fn(),
  call: { findUnique: vi.fn(), update: vi.fn() },
  caller: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  ticket: { create: vi.fn() }
}));
vi.mock("@msva/db", () => ({ databaseReady: db.ready, prisma: db }));
import { createTicket, checkInventory, sendWhatsappConfirmation } from "./tools/crm.js";
import { transferToHuman } from "./tools/transfer.js";
import { handleChat, initialState, setLlmEnabled, streamChat } from "./voiceAgent.js";

const profile: DemoCall = {
  id: "live-call", callerName: "Test caller", phone: "9876543210", callerType: "customer",
  intent: "unknown", language: "hinglish", urgency: "low", transcriptSeed: "", expectedOutcome: "ticket_created"
};
function state(intent: DemoCall["intent"] = "unknown"): ConversationState {
  return initialState({ ...profile, intent });
}
const ticketArgs = { phone: profile.phone, intent: "delivery_delay", summary: "Order 418 is late" };
function decision(name: ToolName, args: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ message: { content: "", tool_calls: [{ function: { name, arguments: args } }] } }), { status: 200 });
}
const failedResponse = () => new Response("unavailable", { status: 503 });

beforeEach(() => {
  vi.clearAllMocks();
  db.ready.mockResolvedValue(false);
  db.call.findUnique.mockResolvedValue({ id: "session-1", fromNumber: profile.phone, callerName: "Test caller", callerType: "CUSTOMER", callerId: "caller-1" });
  db.call.update.mockResolvedValue({ id: "session-1" });
  db.ticket.create.mockResolvedValue({ id: "ticket-row", number: 418 });
  setLlmEnabled(false);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected network request")));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("truthful tools", () => {
  it("does not invent a reference when the ticket database is unavailable", async () => {
    const result = await createTicket("session-1", ticketArgs);
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).toMatch(/unavailable|not saved|could not/i);
  });
  it("reports a failed database insert without a ticket id", async () => {
    db.ready.mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.ticket.create.mockRejectedValueOnce(new Error("database connection lost"));
    const result = await createTicket("session-1", ticketArgs);
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
  });
  it("returns the persisted ticket even if updating the call outcome fails afterward", async () => {
    db.ready.mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.call.update.mockRejectedValueOnce(new Error("call row unavailable"));
    const result = await createTicket("session-1", ticketArgs);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ ticketId: "TKT-418", ticketNumber: 418 });
  });
  it.each([
    ["inventory", () => checkInventory("session-1", { sku: "Dahi", area: "Delhi" })],
    ["WhatsApp", () => sendWhatsappConfirmation("session-1", { phone: profile.phone, template: "confirmation", vars: {} })],
    ["transfer", () => transferToHuman("session-1", { reason: "caller request", summary: "Please connect a person" })]
  ])("reports the unconnected %s integration honestly", async (_name, run) => {
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unavailable|not configured|not connected/i);
    expect(result.data).toBeUndefined();
  });
});

describe("spoken actions and outcomes", () => {
  it.each([
    ["delivery_delay", "My order is late", /ticket|request/i],
    ["product_complaint", "Human agent se baat karwao", /connect|transfer/i],
    ["invoice_payment", "Invoice payment galat hai", /connect|transfer/i],
    ["product_availability", "Delhi mein dahi chahiye", /stock|availability/i]
  ] as const)("keeps failed %s action in progress without promises", async (intent, message, expectedTopic) => {
    const response = await handleChat(profile.id, message, state(intent), "session-1");
    expect(response.state.outcome).toBe("in_progress");
    expect(response.reply).toMatch(expectedTopic);
    expect(response.reply).toMatch(/nahi|nahin|unable|unavailable/i);
    expect(response.reply).not.toMatch(/30 minute|callback|SMS|transfer kar rah|register kar di|981|9876543210/i);
  });
  it("quotes the saved ticket once without a callback deadline", async () => {
    db.ready.mockResolvedValue(true);
    const response = await handleChat(profile.id, "Order 418 late hai", state("delivery_delay"), "session-1");
    expect(response.state.outcome).toBe("ticket_created");
    expect(response.state.collected.ticketId).toBe("TKT-418");
    expect(response.reply).toContain("TKT-418");
    expect(response.reply).not.toMatch(/callback|30 minute|SMS|9876543210/i);
    expect(db.ticket.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ callId: "session-1", summary: "Order 418 late hai" }) }));
  });
  it("does not create another delivery ticket for an acknowledgment", async () => {
    db.ready.mockResolvedValue(true);
    const first = await handleChat(profile.id, "Order 418 late hai", state("delivery_delay"), "session-1");
    const second = await handleChat(profile.id, "Theek hai thanks", first.state, "session-1");
    expect(db.ticket.create).toHaveBeenCalledTimes(1);
    expect(second.state.outcome).toBe("ticket_created");
    expect(second.reply).not.toMatch(/callback|30 minute|9876543210/i);
  });
  it("uses the product and corrected area already supplied when asking the next question", async () => {
    const first = await handleChat(profile.id, "Dahi chahiye", state());
    const second = await handleChat(profile.id, "Delhi nahi, Noida", first.state);
    expect(second.state.collected.product).toBe("dahi");
    expect(second.state.collected.location).toMatch(/Noida/i);
    expect(second.reply).not.toMatch(/product name|area bata|kaunsa product/i);
    expect((second.reply.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
  });
  it("does not mark a direct availability answer as resolved without a successful lookup", async () => {
    setLlmEnabled(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content: "Kitne packs chahiye?" } }))));
    const response = await handleChat(profile.id, "Delhi mein dahi chahiye", state("product_availability"));
    expect(response.state.outcome).toBe("in_progress");
  });
  it("speaks a failed model-selected tool result without letting a follow-up fabricate success", async () => {
    setLlmEnabled(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(decision("send_whatsapp_confirmation", { template: "confirmation" })).mockResolvedValue(new Response(JSON.stringify({ message: { content: "WhatsApp bhej diya hai." }, done: true }) + "\n")));
    const events: ChatStreamEvent[] = [];
    for await (const event of streamChat(profile.id, "WhatsApp par bhej do", state())) events.push(event);
    const final = events.find((event) => event.type === "final");
    expect(final?.type).toBe("final");
    if (final?.type !== "final") throw new Error("missing final event");
    expect(final.state.outcome).toBe("in_progress");
    expect(final.reply).toMatch(/WhatsApp.*nahi|nahi.*WhatsApp/i);
    expect(events.filter((e) => e.type === "token").map((e) => e.text).join("")).toBe(final.reply);
  });
});

describe("order record speech", () => {
  it.each([
    ["7841", /invoice.*pending/i, /expected delivery|invoice_open/i],
    ["1209", /deliver ho chuka/i, /expected delivery|delivered delivered/i]
  ] as const)("describes order record %s without inventing a delivery ETA", async (reference, status, forbidden) => {
    vi.stubEnv("ORDERS_PATH", resolve("data/orders.json"));
    setLlmEnabled(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(decision("lookup_order", { reference })));
    const response = await handleChat(profile.id, `Order ${reference}`, state("order_status"));
    expect(response.reply).toMatch(status);
    expect(response.reply).not.toMatch(forbidden);
    if (reference === "7841") expect(response.reply).toContain("credit note review 48 ghante mein");
  });
});

describe("natural direct model replies", () => {
  function modelText(content: string) {
    setLlmEnabled(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content } }))));
  }
  it("bounds a verbose answer before any text reaches speech", async () => {
    modelText("😊 Bilkul samajh gayi. Aapko kis pack mein chahiye? Kitne packs chahiye? Humari dairy ki poori range bahut acchi hai.");
    const response = await handleChat(profile.id, "Dahi", state());
    expect(response.reply).not.toMatch(/😊|Kitne packs|poori range/);
    expect((response.reply.match(/\?/g) ?? []).length).toBe(1);
  });
  it("keeps only the first question if the model asks two", async () => {
    modelText("Kaunsa pack chahiye? Kitne packs chahiye?");
    const response = await handleChat(profile.id, "Dahi", state());
    expect((response.reply.match(/\?/g) ?? []).length).toBe(1);
  });
  it("does not read the caller phone number aloud", async () => {
    modelText("Aapka number +91 98765 43210 hai. Kaise madad kar sakti hoon?");
    const response = await handleChat(profile.id, "Hello", state());
    expect(response.reply.replace(/[^0-9]/g, "")).not.toContain("9876543210");
  });
  it.each([
    "Maine aapka ticket create kar diya hai.",
    "Main aapko human support ko transfer kar rahi hoon.",
    "WhatsApp bhej diya hai.",
    "30 minute mein team callback karegi.",
    "Dahi stock available hai.",
    "Maine ticket create kar diya hai, aur madad chahiye?",
    "Stock available hai, tension nahi lein.",
    "Stock available hai tension nahi lein."
  ])("rejects an unverified direct action claim: %s", async (claim) => {
    modelText(claim);
    const response = await handleChat(profile.id, "Theek hai", state());
    expect(response.reply).not.toBe(claim);
    expect(response.reply).toMatch(/nahi|nahin|unavailable/i);
    expect(response.state.outcome).toBe("in_progress");
  });
  it("preserves a genuine denial instead of treating it as completed action", async () => {
    modelText("WhatsApp nahi bhej sakti hoon.");
    const response = await handleChat(profile.id, "WhatsApp karo", state());
    expect(response.reply).toBe("WhatsApp nahi bhej sakti hoon.");
  });
  it("uses the fallback source when cleanup removes the whole model reply", async () => {
    modelText("😊");
    const response = await handleChat(profile.id, "Hello", state());
    expect(response.source).toBe("fallback");
    expect(response.reply).toMatch(/dikkat/);
  });
  it("does not speak an invented ticket reference from a direct model reply", async () => {
    modelText("Aapka ticket number TKT-999 hai.");
    const response = await handleChat(profile.id, "Mera ticket number?", state());
    expect(response.reply).not.toContain("TKT-999");
    expect(response.reply).toMatch(/nahi/);
  });
  it("keeps feminine phrasing when the model switches grammatical gender", async () => {
    modelText("Samajh gaya. Main aapki madad kar sakta hoon.");
    const response = await handleChat(profile.id, "Madad chahiye", state());
    expect(response.reply).not.toMatch(/gaya|sakta hoon/);
    expect(response.reply).toMatch(/gayi|sakti hoon/);
  });
  it("does not use a product or area explicitly rejected at the end of a correction", async () => {
    const response = await handleChat(profile.id, "Paneer chahiye, dahi nahi. Noida se hoon, Delhi nahi.", state());
    expect(response.state.collected.product).toBe("paneer");
    expect(response.state.collected.location).toBe("Noida");
  });
  it("keeps the caller's final product correction rather than fixed catalog order", async () => {
    const response = await handleChat(profile.id, "Paneer nahi, dahi chahiye. Delhi nahi Noida.", state());
    expect(response.state.collected.product).toBe("dahi");
    expect(response.state.collected.location).toBe("Noida");
  });
});

describe("provider outages", () => {
  it("does not execute a guessed ticket action when the model is unavailable", async () => {
    setLlmEnabled(true);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(failedResponse));
    const response = await handleChat(profile.id, "Order 418 late hai", state("delivery_delay"));
    expect(response.toolCalls).toEqual([]);
    expect(response.state.outcome).toBe("in_progress");
    expect(response.reply).toMatch(/dikkat|unavailable|dobara/i);
    expect(response.reply).not.toMatch(/ticket number|callback|catalog|availability check/i);
  });
  it("changes the retry response after a second outage instead of looping the same question", async () => {
    setLlmEnabled(true);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(failedResponse));
    const first = await handleChat(profile.id, "Mujhe butter chahiye", state());
    const second = await handleChat(profile.id, "Butter bola tha", first.state);
    expect(second.reply).not.toBe(first.reply);
    expect(second.reply).not.toMatch(/product name|quantity aur area|catalog|availability check/i);
  });
});

describe("Anthropic provider contract", () => {
  async function agent() {
    vi.resetModules();
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
    const module = await import("./voiceAgent.js");
    module.setLlmEnabled(true);
    return module;
  }
  it("keeps a failed model-selected transfer in progress and speaks the failure", async () => {
    const module = await agent();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "tool_use", id: "tu-1", name: "transfer_to_human", input: { reason: "caller request", summary: "caller requests human" } }] }))));
    const response = await module.handleChat(profile.id, "Human se baat karwao", state());
    expect(response.state.outcome).toBe("in_progress");
    expect(response.reply).toMatch(/connect nahi/);
    expect(response.reply).not.toContain(profile.phone);
  });
  it("keeps a saved ticket visible alongside a failed WhatsApp confirmation", async () => {
    const module = await agent();
    db.ready.mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [
      { type: "tool_use", id: "tu-1", name: "create_ticket", input: { summary: "Order 418 late" } },
      { type: "tool_use", id: "tu-2", name: "send_whatsapp_confirmation", input: { template: "confirmation" } }
    ] }))));
    const response = await module.handleChat(profile.id, "Ticket bana kar WhatsApp karo", state(), "session-1");
    expect(response.state.outcome).toBe("ticket_created");
    expect(response.reply).toContain("TKT-418");
    expect(response.reply).toMatch(/WhatsApp.*nahi/);
    expect(response.reply).not.toMatch(/callback|SMS|9876543210/i);
  });
  it("times out a stalled response body and returns an honest fallback", async () => {
    const module = await agent();
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, options: RequestInit) => {
      return new Response(new ReadableStream({
        start(controller) {
          options.signal!.addEventListener("abort", () => controller.error(new Error("body aborted")), { once: true });
        }
      }), { status: 200 });
    }));
    let completed: Awaited<ReturnType<typeof module.handleChat>> | undefined;
    const pending = module.handleChat(profile.id, "Order late hai", state("delivery_delay")).then((response) => { completed = response; });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(completed?.source).toBe("fallback");
    expect(completed?.toolCalls).toEqual([]);
    expect(completed?.reply).toMatch(/dikkat/);
    await pending;
  });
  it("handles HTTP failure without heuristic actions", async () => {
    const module = await agent();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockImplementation(failedResponse));
    const response = await module.handleChat(profile.id, "Order late hai", state("delivery_delay"));
    expect(response.toolCalls).toEqual([]);
    expect(response.state.outcome).toBe("in_progress");
    expect(response.reply).toMatch(/dikkat/);
  });
});
