import type { ToolCall, ToolName, ToolResult } from "@msva/shared";
import {
  checkInventory,
  createTicket,
  lookupOrder,
  sendWhatsappConfirmation
} from "./crm.js";
import { transferToHuman } from "./transfer.js";

// ---------------------------------------------------------------------------
// Tool registry + dispatch.
//
// The agent loop never imports the individual tool files directly — it
// emits `ToolCall` events and waits for `ToolResult` events. This file is
// the one place that knows how to bind a `ToolName` to its handler, which
// keeps the loop pure and lets us mock tools cleanly in tests.
// ---------------------------------------------------------------------------

export const toolNames: ToolName[] = [
  "lookup_order",
  "create_ticket",
  "check_inventory",
  "transfer_to_human",
  "send_whatsapp_confirmation"
];

export async function dispatchTool(callId: string, call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "lookup_order":
        return await lookupOrder(callId, call.args as Parameters<typeof lookupOrder>[1]);
      case "create_ticket":
        return await createTicket(callId, call.args as Parameters<typeof createTicket>[1]);
      case "check_inventory":
        return await checkInventory(callId, call.args as Parameters<typeof checkInventory>[1]);
      case "transfer_to_human":
        return await transferToHuman(callId, call.args as Parameters<typeof transferToHuman>[1]);
      case "send_whatsapp_confirmation":
        return await sendWhatsappConfirmation(
          callId,
          call.args as Parameters<typeof sendWhatsappConfirmation>[1]
        );
      default: {
        const _exhaustive: never = call.name;
        return {
          id: call.id,
          name: call.name,
          ok: false,
          error: `Unknown tool: ${String(_exhaustive)}`
        };
      }
    }
  } catch (error) {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      error: error instanceof Error ? error.message : "unknown tool error"
    };
  }
}

let toolCallCounter = 0;
export function nextToolCallId(): string {
  toolCallCounter += 1;
  return `tc_${Date.now().toString(36)}_${toolCallCounter}`;
}
