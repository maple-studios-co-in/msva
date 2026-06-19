import type { DemoCall } from "@msva/shared";

// ---------------------------------------------------------------------------
// Demo inbound calls — scoped to the Madhusudan dairy catalog.
//
// Real SKUs referenced (from madhusudanworld.com):
//   • Milk:       Cow / Toned / Full Cream / Tea Special / Double Toned
//   • Ghee:       Desi Ghee Tin / Bucket / Jar / Poly Pack / Ceka Pack
//   • Dahi:       Lite (cup / jar), Magic (cup / jar)
//   • Paneer:     Fresh Paneer
//   • Butter:     Butter, Butter Chiplet
//   • Other:      Chaach, Gulab Jamun Mix, Fresh Cream 200 ml / 1 L,
//                 Flavored Milk (Elaichi / Kesar Badam / Coffee), UHT Milk
//
// These will be replaced with fixtures derived from the real call transcripts
// once `transcribe-samples.mjs` finishes — keeping them here for the
// dashboard demo until then.
// ---------------------------------------------------------------------------

export const demoCalls: DemoCall[] = [
  {
    id: "call-dist-ghee-delay",
    callerName: "Rajesh Gupta",
    phone: "9818160910",
    callerType: "distributor",
    intent: "delivery_delay",
    language: "hinglish",
    urgency: "medium",
    transcriptSeed:
      "Distributor ko kal subah Desi Ghee Tin aur 1 ltr Ceka Pack ka shipment milna tha. Ghaziabad route par truck abhi tak nahi pahuncha, retailers wait kar rahe hain.",
    expectedOutcome: "ticket_created"
  },
  {
    id: "call-customer-paneer-quality",
    callerName: "Neha Sharma",
    phone: "8757401698",
    callerType: "customer",
    intent: "product_complaint",
    language: "hinglish",
    urgency: "high",
    transcriptSeed:
      "Customer bata rahi hain Madhusudan Fresh Paneer 1 kg liya tha, kharab smell aa rahi hai aur texture rubbery hai. Batch number aur expiry date packet pe likha hai, share kar sakti hain.",
    expectedOutcome: "human_transfer"
  },
  {
    id: "call-retailer-dahi-availability",
    callerName: "Amit Dairy Store",
    phone: "9997269252",
    callerType: "retailer",
    intent: "product_availability",
    language: "hinglish",
    urgency: "low",
    transcriptSeed:
      "Retailer ko Dahi Magic 400 gm Cup Pack ke 20 crates aur Dahi Lite 5 kg Jar Pack ke 6 crates chahiye, area Ghaziabad. Aaj evening tak dispatch ho sake to acha rahega.",
    expectedOutcome: "resolved_by_va"
  },
  {
    id: "call-distributor-ghee-payment",
    callerName: "Sanjay Traders",
    phone: "9650462147",
    callerType: "distributor",
    intent: "invoice_payment",
    language: "hinglish",
    urgency: "medium",
    transcriptSeed:
      "Distributor ko pichle month Desi Ghee Poly Pack 1 kg ke invoice ka credit note adjustment chahiye. Total amount around 84,000 hai, accounts team se baat karwana hai.",
    expectedOutcome: "human_transfer"
  }
];

export function findDemoCall(callId: string): DemoCall {
  return demoCalls.find((call) => call.id === callId) ?? demoCalls[0];
}
