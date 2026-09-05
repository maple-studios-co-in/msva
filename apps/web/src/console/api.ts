// ---------------------------------------------------------------------------
// Console API client — thin wrapper over /api/admin/*.
//
// Requests carry the session cookie (credentials: "include"). A 401 surfaces
// as ApiError(401) so the shell can drop back to the login screen.
// ---------------------------------------------------------------------------

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4100";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

// ---------------------------------------------------------------------------
// Types (mirror the admin API responses)
// ---------------------------------------------------------------------------

export type Role = "ADMIN" | "SUPERVISOR" | "AGENT" | "VIEWER";
export type SessionUser = { id: string; email: string; name: string; role: Role };

export type Paged<T> = { items: T[]; page: number; pageSize: number; total: number };

export type Overview = {
  today: {
    calls: number;
    transferred: number;
    handledByAgent: number;
    avgTtfwMs: number | null;
    outcomes: Record<string, number>;
  };
  liveNow: number;
  tickets: { open: number; slaBreaches: number };
};

export type CallStatus = "QUEUED" | "RINGING" | "IN_PROGRESS" | "COMPLETED" | "NO_ANSWER" | "FAILED";
export type CallOutcome = "IN_PROGRESS" | "RESOLVED_BY_VA" | "TICKET_CREATED" | "HUMAN_TRANSFER" | "ABANDONED";
export type CallerType = "DISTRIBUTOR" | "RETAILER" | "CUSTOMER" | "FARMER" | "UNKNOWN";

export type CallRow = {
  id: string;
  provider: "BROWSER" | "EXOTEL" | "TWILIO";
  direction: "INBOUND" | "OUTBOUND";
  isTest: boolean;
  status: CallStatus;
  outcome: CallOutcome;
  fromNumber: string;
  callerName: string | null;
  callerType: CallerType;
  intent: string | null;
  escalationReason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  costPaise: number | null;
  agent: { id: string; name: string } | null;
  caller: { id: string; name: string | null; type: CallerType; code: string | null; area: string | null } | null;
  tickets: { id: string; number: number; status: TicketStatus }[];
  _count: { turns: number };
};

export type Turn = {
  id: string;
  index: number;
  callerText: string | null;
  replyText: string | null;
  asrMs: number | null;
  llmFirstTokenMs: number | null;
  llmTotalMs: number | null;
  ttsFirstByteMs: number | null;
  ttfwMs: number | null;
  interrupted: boolean;
  source: string | null;
  toolCalls: unknown;
};

export type Utterance = { id: string; seq: number; speaker: "CALLER" | "AGENT"; text: string; atMs: number | null };

export type CallDetail = Omit<CallRow, "_count" | "tickets"> & {
  language: string | null;
  collected: Record<string, string>;
  metadata: Record<string, unknown> | null;
  turns: Turn[];
  utterances: Utterance[];
  tickets: TicketRow[];
};

export type TicketStatus = "OPEN" | "IN_PROGRESS" | "WAITING" | "RESOLVED" | "CLOSED";
export type TicketPriority = "LOW" | "MEDIUM" | "HIGH";

export type TicketRow = {
  id: string;
  number: number;
  callId: string | null;
  phone: string;
  callerName: string | null;
  intent: string;
  priority: TicketPriority;
  status: TicketStatus;
  summary: string;
  details: Record<string, unknown> | null;
  assigneeId: string | null;
  assignee: { id: string; name: string; email?: string } | null;
  caller: { id: string; name: string | null; type: CallerType; code: string | null; area: string | null } | null;
  call: { id: string; startedAt: string; outcome: CallOutcome; intent: string | null } | null;
  slaDueAt: string | null;
  callbackStart: string | null;
  callbackEnd: string | null;
  resolutionCode: string | null;
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type TicketNote = { id: string; text: string; createdAt: string; author: { id: string; name: string } | null };
export type TicketDetail = TicketRow & { notes: TicketNote[] };

export type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  lastLoginAt: string | null;
  createdAt?: string;
};

export type AuditRow = {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
};

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const api = {
  me: () => call<{ user: SessionUser }>("/api/admin/me"),
  requestCode: (email: string) =>
    call<{ ok: true; devCode?: string }>("/api/admin/auth/request-code", {
      method: "POST",
      body: JSON.stringify({ email })
    }),
  verify: (email: string, code: string) =>
    call<{ user: SessionUser }>("/api/admin/auth/verify", { method: "POST", body: JSON.stringify({ email, code }) }),
  logout: () => call<{ ok: true }>("/api/admin/auth/logout", { method: "POST" }),

  overview: () => call<Overview>("/api/admin/overview"),

  calls: (params: Record<string, string | number | undefined>) => call<Paged<CallRow>>(`/api/admin/calls${qs(params)}`),
  call: (id: string) => call<CallDetail>(`/api/admin/calls/${encodeURIComponent(id)}`),
  patchCall: (id: string, body: { isTest?: boolean }) =>
    call<CallDetail>(`/api/admin/calls/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),

  tickets: (params: Record<string, string | number | undefined>) =>
    call<Paged<TicketRow>>(`/api/admin/tickets${qs(params)}`),
  ticket: (id: string) => call<TicketDetail>(`/api/admin/tickets/${encodeURIComponent(id)}`),
  patchTicket: (id: string, body: Partial<Pick<TicketRow, "status" | "priority" | "assigneeId" | "callbackStart" | "callbackEnd" | "resolutionCode">>) =>
    call<TicketRow>(`/api/admin/tickets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  addNote: (id: string, text: string) =>
    call<TicketNote>(`/api/admin/tickets/${encodeURIComponent(id)}/notes`, { method: "POST", body: JSON.stringify({ text }) }),

  users: () => call<UserRow[]>("/api/admin/users"),
  createUser: (body: { email: string; name: string; role: Role }) =>
    call<UserRow>("/api/admin/users", { method: "POST", body: JSON.stringify(body) }),
  patchUser: (id: string, body: { name?: string; role?: Role; active?: boolean }) =>
    call<UserRow>(`/api/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),

  audit: (params: Record<string, string | number | undefined>) => call<Paged<AuditRow>>(`/api/admin/audit${qs(params)}`)
};
