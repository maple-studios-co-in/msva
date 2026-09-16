// Keep these fixed lines aligned with data/prompts.json so either transport can
// replay the same female persona from its sample-rate-specific prompt cache.
export const CALL_GREETING = process.env.CALL_GREETING?.trim() ||
  "Namaste, main Madhusudan ki AI assistant hoon. Kaise madad kar sakti hoon?";
export const ASR_RETRY = "Maaf kijiye, aapki baat sun nahi paayi. Dobara kahiye.";
