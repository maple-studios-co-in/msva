import type { ToolResult } from "@msva/shared";

// ---------------------------------------------------------------------------
// Human-transfer tool
//
// In production this signals the telephony layer to dial the human queue
// and warm-transfer the caller. The telephony pipeline listens for a
// `transfer_to_human` tool_result event and issues the provider-specific
// dial command (Exotel <Dial>, Twilio <Dial>, Plivo <Dial>).
// ---------------------------------------------------------------------------

export type TransferToHumanArgs = {
  reason: string;
  summary: string;
  queue?: "complaints" | "accounts" | "sales" | "general";
};

export async function transferToHuman(
  callId: string,
  args: TransferToHumanArgs
): Promise<ToolResult> {
  const queue = args.queue ?? "general";
  // TODO: emit a side-channel event to the telephony service so it can
  // initiate the warm transfer. For the REST demo we just acknowledge.
  return {
    id: callId,
    name: "transfer_to_human",
    ok: true,
    data: {
      queued: true,
      queue,
      reason: args.reason,
      summary: args.summary,
      // The telephony pipeline uses this id to correlate the dial command
      // with the original call.
      transferId: `XFER-${Date.now().toString().slice(-6)}`
    }
  };
}
