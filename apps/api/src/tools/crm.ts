import fs from "node:fs";
import path from "node:path";
import type { ToolResult } from "@msva/shared";
import { databaseReady, prisma } from "@msva/db";
import { ensureCaller, toCallerType } from "../calls.js";

// ---------------------------------------------------------------------------
// CRM / helpdesk tools
//
// `lookupOrder` is a REAL backend: it queries a seeded order datastore
// (data/orders.json) by reference (order/invoice number) or caller phone and
// returns live status / ETA / items. The remaining tools are still stubs —
// wire them to whatever the customer actually uses (Freshdesk, Zoho Desk,
// Salesforce, WhatsApp Business API) by replacing the function bodies. The
// shape — args in, ToolResult out — is what the agent loop and the telephony
// pipeline consume, so the caller code does not change when you swap impls.
// ---------------------------------------------------------------------------

type OrderRecord = {
  orderId: string;
  reference: string;
  phone: string;
  callerName: string;
  status: string;
  eta: string;
  area: string;
  items: string[];
  carrier: string;
  note: string;
};

let orderCache: OrderRecord[] | null = null;

function loadOrders(): OrderRecord[] {
  if (orderCache) return orderCache;
  const ordersPath =
    process.env.ORDERS_PATH ?? path.resolve(process.cwd(), "../../data/orders.json");
  try {
    orderCache = JSON.parse(fs.readFileSync(ordersPath, "utf8")) as OrderRecord[];
  } catch (error) {
    console.error("[crm] could not load orders datastore", error);
    orderCache = [];
  }
  return orderCache;
}

function digits(value: string | undefined): string {
  return (value ?? "").replace(/[^0-9]/g, "");
}

export type LookupOrderArgs = { phone: string; reference?: string };
export type CreateTicketArgs = {
  phone: string;
  intent: string;
  summary: string;
  priority?: "low" | "medium" | "high";
};
export type CheckInventoryArgs = { sku: string; area: string };
export type SendWhatsappArgs = {
  phone: string;
  template: string;
  vars: Record<string, string>;
};

export async function lookupOrder(
  callId: string,
  args: LookupOrderArgs
): Promise<ToolResult> {
  const orders = loadOrders();
  const ref = digits(args.reference);
  const phone = digits(args.phone);

  // Match on order/invoice reference first (most specific), then phone.
  const match =
    (ref && orders.find((order) => digits(order.reference) === ref || digits(order.orderId) === ref)) ||
    (phone && orders.find((order) => digits(order.phone) === phone)) ||
    null;

  if (!match) {
    return {
      id: callId,
      name: "lookup_order",
      ok: true,
      data: { found: false, reference: args.reference ?? null, phone: args.phone ?? null }
    };
  }

  return {
    id: callId,
    name: "lookup_order",
    ok: true,
    data: {
      found: true,
      orderId: match.orderId,
      status: match.status,
      eta: match.eta,
      area: match.area,
      items: match.items,
      carrier: match.carrier,
      note: match.note
    }
  };
}

export async function createTicket(
  callId: string,
  args: CreateTicketArgs
): Promise<ToolResult> {
  const priority = args.priority ?? "medium";
  const intent = args.intent || "unknown";
  const summary = args.summary?.trim() || "Caller request (no summary captured)";

  // Built-in ticket queue. External helpdesk sync (Freshdesk / Zoho) arrives in
  // Phase 2 and will mirror this row rather than replace it.
  try {
    if (await databaseReady()) {
      const call = await prisma.call.findUnique({
        where: { id: callId },
        select: { id: true, fromNumber: true, callerName: true, callerType: true, callerId: true }
      });
      const phone = digits(args.phone) || digits(call?.fromNumber);
      const caller =
        call?.callerId ??
        (await ensureCaller(phone, { name: call?.callerName, type: toCallerType(call?.callerType) }))?.id ??
        null;
      const ticket = await prisma.ticket.create({
        data: {
          callId: call?.id,
          callerId: caller,
          phone: phone || "unknown",
          callerName: call?.callerName ?? undefined,
          intent,
          priority: priority.toUpperCase() as "LOW" | "MEDIUM" | "HIGH",
          summary,
          details: { source: "voice_agent", args }
        }
      });
      if (call) {
        await prisma.call.update({ where: { id: call.id }, data: { outcome: "TICKET_CREATED" } });
      }
      return {
        id: callId,
        name: "create_ticket",
        ok: true,
        data: { ticketId: `TKT-${ticket.number}`, ticketNumber: ticket.number, priority, intent, summary }
      };
    }
  } catch (error) {
    console.error("[crm] ticket persistence failed, falling back to in-memory id", error);
  }

  // No database (or it is down): keep the call alive with a reference the
  // caller can quote; the console will not see it.
  const ticketId = `TKT-${args.phone.slice(-4)}-${Date.now().toString().slice(-4)}`;
  return {
    id: callId,
    name: "create_ticket",
    ok: true,
    data: { ticketId, priority, intent, summary, persisted: false }
  };
}

export async function checkInventory(
  callId: string,
  args: CheckInventoryArgs
): Promise<ToolResult> {
  // TODO: hit warehouse / DMS. Stub returns a believable availability bucket.
  const available = !/lassi/i.test(args.sku) || /ghaziabad|delhi|noida/i.test(args.area);
  return {
    id: callId,
    name: "check_inventory",
    ok: true,
    data: { sku: args.sku, area: args.area, available, nextRestockHours: available ? 0 : 18 }
  };
}

export async function sendWhatsappConfirmation(
  callId: string,
  args: SendWhatsappArgs
): Promise<ToolResult> {
  // TODO: integrate WhatsApp Business API (Gupshup, Wati, or Meta direct).
  // For now just echo what would be sent.
  return {
    id: callId,
    name: "send_whatsapp_confirmation",
    ok: true,
    data: { queued: true, template: args.template, to: args.phone, vars: args.vars }
  };
}
