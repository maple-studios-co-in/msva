import type { ToolResult } from "@msva/shared";

// A transfer is successful only after a telephony provider accepts it.
// No provider handoff is wired yet, so this integration reports unavailable.

export type TransferToHumanArgs = {
  reason: string;
  summary: string;
  queue?: "complaints" | "accounts" | "sales" | "general";
};

export async function transferToHuman(
  callId: string,
  _args: TransferToHumanArgs
): Promise<ToolResult> {
  return {
    id: callId,
    name: "transfer_to_human",
    ok: false,
    error: "Human transfer is not connected; the caller has not been transferred."
  };
}
