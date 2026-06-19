export type CallStatus = "ANSWERED" | "UNANSWERED" | "MISSCALL";

export type CallRecord = {
  src: string;
  associatedMobile: string;
  callStartTime: string;
  durationIn: number;
  durationOut: number;
  callStatusOut: CallStatus;
  callLevelDepartment: string;
  ifVoicemail: boolean;
  ifCallRecording: boolean;
  agentName?: string;
  outgoingPicked?: string;
};

export type KpiSummary = {
  totalCalls: number;
  uniqueCallers: number;
  answeredCalls: number;
  unansweredCalls: number;
  missedCalls: number;
  voicemailCalls: number;
  answerRate: number;
  repeatCallerShare: number;
  medianInboundDuration: number;
  medianAnsweredDuration: number;
  peakWindow: string;
};

export type TimeBandMetric = {
  band: string;
  calls: number;
  answered: number;
  unanswered: number;
  missed: number;
  voicemail: number;
  answerRate: number;
};

export type StatusMetric = {
  status: CallStatus;
  calls: number;
  share: number;
};

export type RepeatCallerMetric = {
  threshold: string;
  callers: number;
  calls: number;
  share: number;
};

export type AgentMetric = {
  name: string;
  calls: number;
};

export type DailyMetric = {
  date: string;
  calls: number;
  answered: number;
};

export type AnalyticsResponse = {
  kpis: KpiSummary;
  status: StatusMetric[];
  timeBands: TimeBandMetric[];
  repeatCallers: RepeatCallerMetric[];
  agents: AgentMetric[];
  daily: DailyMetric[];
  findings: string[];
};

export type VoiceIntent =
  | "order_status"
  | "delivery_delay"
  | "product_complaint"
  | "product_availability"
  | "invoice_payment"
  | "scheme_pricing"
  | "human_agent"
  | "unknown";

export type CallerType = "distributor" | "retailer" | "customer" | "unknown";

export type DemoCall = {
  id: string;
  callerName: string;
  phone: string;
  callerType: CallerType;
  intent: VoiceIntent;
  language: "hinglish" | "hindi" | "english";
  urgency: "low" | "medium" | "high";
  transcriptSeed: string;
  expectedOutcome: "resolved_by_va" | "ticket_created" | "human_transfer";
};

export type ConversationMessage = {
  role: "assistant" | "caller" | "system";
  text: string;
  timestamp: string;
};

export type ConversationState = {
  call: DemoCall;
  messages: ConversationMessage[];
  collected: Record<string, string>;
  outcome: DemoCall["expectedOutcome"] | "in_progress";
  escalationReason?: string;
};

export type ChatRequest = {
  callId: string;
  message: string;
  state?: ConversationState;
};

export type ChatResponse = {
  reply: string;
  state: ConversationState;
  model: string;
  source: "ollama" | "fallback";
  toolCalls?: ToolCall[];
};

// ---------------------------------------------------------------------------
// Tool calling
// ---------------------------------------------------------------------------

export type ToolName =
  | "lookup_order"
  | "create_ticket"
  | "check_inventory"
  | "transfer_to_human"
  | "send_whatsapp_confirmation";

export type ToolCall = {
  id: string;
  name: ToolName;
  args: Record<string, unknown>;
};

export type ToolResult = {
  id: string;
  name: ToolName;
  ok: boolean;
  data?: unknown;
  error?: string;
};

// ---------------------------------------------------------------------------
// Streaming chat events
//
// `streamChat` yields a sequence of these events for a single caller turn.
// The REST endpoint collects them into a `ChatResponse`; the telephony
// pipeline forwards `token` events into the TTS stream so audio starts
// playing back before the LLM has finished generating.
// ---------------------------------------------------------------------------

export type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; result: ToolResult }
  | {
      type: "final";
      reply: string;
      state: ConversationState;
      model: string;
      source: "ollama" | "fallback";
      toolCalls: ToolCall[];
    }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Telephony
//
// `TelephonyCall` is the real-call counterpart to `DemoCall` — it carries
// the provider call id, the inbound number, and the inferred caller profile.
// `CallTurn` records per-turn latencies so the analytics dashboard can show
// time-to-first-word, ASR/LLM/TTS breakdown, and interruption rates.
// ---------------------------------------------------------------------------

export type TelephonyProvider = "exotel" | "twilio" | "plivo";

export type TelephonyCall = {
  callSid: string;
  provider: TelephonyProvider;
  fromNumber: string;
  toNumber: string;
  startedAt: string;
  endedAt?: string;
  // The DemoCall shape we reuse for the agent logic — populated from a
  // phone-number lookup against the CRM. Falls back to an "unknown caller"
  // profile if nothing is found.
  profile: DemoCall;
};

export type CallTurn = {
  turnIndex: number;
  callerUtterance: string;
  asrMs: number;
  llmFirstTokenMs: number;
  llmTotalMs: number;
  ttsFirstByteMs: number;
  ttsTotalMs: number;
  interrupted: boolean;
  reply: string;
};

export type CallSession = {
  call: TelephonyCall;
  conversation: ConversationState;
  turns: CallTurn[];
};

// ---------------------------------------------------------------------------
// Live call metrics
//
// Emitted once per turn by the in-browser call pipeline so the call screen can
// show real latency: how long ASR, the LLM, and TTS each took, plus the
// perceived "time to first word" (caller stopped speaking → first audio heard).
// All values are milliseconds; null where not applicable (e.g. ASR on the
// opening greeting, which has no caller utterance).
// ---------------------------------------------------------------------------

export type LiveTurnMetrics = {
  turnIndex: number;
  asrMs: number | null;
  llmFirstTokenMs: number | null;
  llmTotalMs: number | null;
  ttsFirstByteMs: number | null;
  ttfwMs: number | null;
  interrupted: boolean;
};
