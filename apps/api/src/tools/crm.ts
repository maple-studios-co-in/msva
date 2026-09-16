import fs from "node:fs";
import path from "node:path";
import type { ToolResult } from "@msva/shared";
import { databaseReady, prisma } from "@msva/db";
import { ensureCaller, toCallerType } from "../calls.js";

// ---------------------------------------------------------------------------
// CRM / helpdesk tools
//
// `lookupOrder` queries a seeded order datastore
// (data/orders.json) by reference (order/invoice number) or caller phone and
// returns that snapshot status / ETA / items. Ticket creation persists to the
// built-in queue. Unconnected integrations return explicit failures —
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
        try {
          await prisma.call.update({ where: { id: call.id }, data: { outcome: "TICKET_CREATED" } });
        } catch (error) {
          // The ticket is already saved; a dashboard update must not turn it
          // into a failed creation or encourage a duplicate ticket.
          console.error("[crm] ticket saved but call outcome update failed", error);
        }
      }
      return {
        id: callId,
        name: "create_ticket",
        ok: true,
        data: { ticketId: `TKT-${ticket.number}`, ticketNumber: ticket.number, priority, intent, summary }
      };
    }
  } catch (error) {
    console.error("[crm] ticket persistence failed", error);
  }

  return {
    id: callId,
    name: "create_ticket",
    ok: false,
    error: "Ticket storage is unavailable; the request was not saved."
  };
}

export async function checkInventory(
  callId: string,
  _args: CheckInventoryArgs
): Promise<ToolResult> {
  // No inventory provider is connected; never infer stock from an SKU/area.
  return {
    id: callId,
    name: "check_inventory",
    ok: false,
    error: "Live inventory is not connected; availability cannot be confirmed."
  };
}

export async function sendWhatsappConfirmation(
  callId: string,
  _args: SendWhatsappArgs
): Promise<ToolResult> {
  return {
    id: callId,
    name: "send_whatsapp_confirmation",
    ok: false,
    error: "WhatsApp delivery is not configured; no message was sent or queued."
  };
}
