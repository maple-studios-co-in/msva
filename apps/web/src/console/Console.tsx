import {
  Activity,
  BarChart3,
  LogOut,
  PhoneCall,
  Ticket as TicketIcon,
  Users as UsersIcon,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  ApiError,
  type CallDetail,
  type CallOutcome,
  type CallRow,
  type Overview,
  type Paged,
  type Role,
  type SessionUser,
  type TicketDetail,
  type TicketRow,
  type TicketStatus,
  type UserRow
} from "./api";

// ---------------------------------------------------------------------------
// Console v0 — overview, call history with drawer, ticket queue, users.
//
// Routing is hash-based (#/calls, #/calls/<id>, #/tickets/<id> …) so the
// console is one static HTML file the same Caddy config already serves.
// ---------------------------------------------------------------------------

type Route = { page: "overview" | "calls" | "tickets" | "users"; id?: string };

function parseHash(): Route {
  const [page = "overview", id] = location.hash.replace(/^#\/?/, "").split("/");
  if (page === "calls" || page === "tickets" || page === "users") return { page, id: id || undefined };
  return { page: "overview" };
}

function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((next: Route) => {
    location.hash = next.id ? `#/${next.page}/${encodeURIComponent(next.id)}` : `#/${next.page}`;
  }, []);
  return [route, navigate];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const fmtTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

const fmtDuration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return "—";
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
};

const fmtMs = (ms: number | null | undefined): string => (ms === null || ms === undefined ? "—" : `${ms} ms`);

const titleCase = (value: string | null | undefined): string =>
  (value ?? "unknown").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const outcomeTone: Record<CallOutcome, string> = {
  IN_PROGRESS: "info",
  RESOLVED_BY_VA: "ok",
  TICKET_CREATED: "warn",
  HUMAN_TRANSFER: "bad",
  ABANDONED: ""
};

const ticketTone: Record<TicketStatus, string> = {
  OPEN: "warn",
  IN_PROGRESS: "info",
  WAITING: "",
  RESOLVED: "ok",
  CLOSED: ""
};

const Badge = ({ tone, children }: { tone?: string; children: ReactNode }) => (
  <span className={`co-badge ${tone ?? ""}`}>{children}</span>
);

const RANK: Record<Role, number> = { VIEWER: 0, AGENT: 1, SUPERVISOR: 2, ADMIN: 3 };
const atLeast = (user: SessionUser | null, role: Role) => !!user && RANK[user.role] >= RANK[role];

// ---------------------------------------------------------------------------
// Data hook
// ---------------------------------------------------------------------------

function useLoad<T>(loader: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loader()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Something went wrong");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function Console() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => setChecked(true));
  }, []);

  // Any 401 from a page drops back to login.
  const onAuthError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) setUser(null);
  }, []);

  if (!checked) return <div className="co-login"><p className="co-hint">Loading console…</p></div>;
  if (!user) return <Login onSignedIn={setUser} />;
  return <Shell user={user} onSignOut={() => setUser(null)} onAuthError={onAuthError} />;
}

function Login({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const requestCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.requestCode(email);
      setStage("code");
      setHint(result.devCode ? `Development mode: your code is ${result.devCode}` : "If that email has access, a 6-digit code is on its way.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request a code");
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.verify(email, code);
      onSignedIn(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="co-login">
      <form className="co-login-card" onSubmit={stage === "email" ? requestCode : verify}>
        <h1>Madhusudan Console</h1>
        <p>{stage === "email" ? "Sign in with your work email. We will send a one-time code." : `Enter the code sent to ${email}.`}</p>
        {stage === "email" ? (
          <input className="co-input" type="email" placeholder="you@madhusudan.example" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        ) : (
          <input className="co-input" inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required />
        )}
        {hint && <div className="co-hint">{hint}</div>}
        {error && <div className="co-error">{error}</div>}
        <button className="co-btn primary" disabled={busy}>
          {busy ? "Please wait…" : stage === "email" ? "Send code" : "Sign in"}
        </button>
        {stage === "code" && (
          <button type="button" className="co-btn" onClick={() => setStage("email")}>
            Use a different email
          </button>
        )}
      </form>
    </div>
  );
}

function Shell({ user, onSignOut, onAuthError }: { user: SessionUser; onSignOut: () => void; onAuthError: (error: unknown) => void }) {
  const [route, navigate] = useRoute();
  const signOut = async () => {
    await api.logout().catch(() => undefined);
    onSignOut();
  };
  const link = (page: Route["page"], label: string, icon: ReactNode) => (
    <a href={`#/${page}`} className={route.page === page ? "active" : ""}>
      {icon}
      {label}
    </a>
  );
  return (
    <div className="co-shell">
      <aside className="co-side">
        <div className="brand">
          <div className="brand-mark" aria-label="Madhusudan">MS</div>
          <div>
            <strong>Madhusudan</strong>
            <span>Support console</span>
          </div>
        </div>
        <nav>
          {link("overview", "Overview", <Activity size={17} />)}
          {link("calls", "Calls", <PhoneCall size={17} />)}
          {link("tickets", "Tickets", <TicketIcon size={17} />)}
          {atLeast(user, "ADMIN") && link("users", "Users", <UsersIcon size={17} />)}
        </nav>
        <div className="co-user">
          <strong>{user.name}</strong>
          {user.email} · {titleCase(user.role)}
          <div>
            <button className="co-btn" onClick={signOut}>
              <LogOut size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="co-main">
        {route.page === "overview" && <OverviewPage onAuthError={onAuthError} navigate={navigate} />}
        {route.page === "calls" && <CallsPage user={user} route={route} navigate={navigate} onAuthError={onAuthError} />}
        {route.page === "tickets" && <TicketsPage user={user} route={route} navigate={navigate} onAuthError={onAuthError} />}
        {route.page === "users" && atLeast(user, "ADMIN") && <UsersPage me={user} onAuthError={onAuthError} />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewPage({ onAuthError, navigate }: { onAuthError: (e: unknown) => void; navigate: (r: Route) => void }) {
  const overview = useLoad<Overview>(() => api.overview().catch((e) => (onAuthError(e), Promise.reject(e))), []);
  const recent = useLoad<Paged<CallRow>>(() => api.calls({ isTest: "all", pageSize: 8 }), []);
  const o = overview.data;
  return (
    <>
      <div className="co-head">
        <div>
          <h1>Today</h1>
          <p>Live traffic only. Test calls are excluded from these numbers.</p>
        </div>
        <button className="co-btn" onClick={() => { overview.reload(); recent.reload(); }}>Refresh</button>
      </div>
      {overview.error && <div className="co-error">{overview.error}</div>}
      <div className="co-kpis">
        <div className="co-kpi"><span>Calls today</span><strong className="co-num">{o?.today.calls ?? "—"}</strong><small>{o ? `${o.today.handledByAgent} handled by the agent` : ""}</small></div>
        <div className="co-kpi"><span>Transferred to a human</span><strong className="co-num">{o?.today.transferred ?? "—"}</strong><small>{o && o.today.calls ? `${Math.round((o.today.transferred / o.today.calls) * 100)}% of calls` : ""}</small></div>
        <div className="co-kpi"><span>Live now</span><strong className="co-num">{o?.liveNow ?? "—"}</strong><small>calls in progress</small></div>
        <div className="co-kpi"><span>Open tickets</span><strong className="co-num">{o?.tickets.open ?? "—"}</strong><small>{o ? `${o.tickets.slaBreaches} past SLA` : ""}</small></div>
        <div className="co-kpi"><span>Time to first word</span><strong className="co-num">{o?.today.avgTtfwMs ? `${(o.today.avgTtfwMs / 1000).toFixed(1)}s` : "—"}</strong><small>average today</small></div>
      </div>
      <div className="co-head"><div><h1 style={{ fontSize: 18 }}>Recent calls</h1></div><a className="co-btn" href="#/calls">All calls</a></div>
      <CallsTable page={recent.data} loading={recent.loading} onOpen={(id) => navigate({ page: "calls", id })} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

function CallsTable({ page, loading, onOpen, selectedId }: { page: Paged<CallRow> | null; loading: boolean; onOpen: (id: string) => void; selectedId?: string }) {
  return (
    <div className="co-tablewrap">
      <table className="co-table">
        <thead>
          <tr>
            <th>When</th><th>Caller</th><th>Type</th><th>Intent</th><th>Outcome</th><th>Duration</th><th>Turns</th><th>Ticket</th><th></th>
          </tr>
        </thead>
        <tbody>
          {page?.items.map((row) => (
            <tr key={row.id} className={`row ${selectedId === row.id ? "selected" : ""}`} onClick={() => onOpen(row.id)}>
              <td className="co-num">{fmtTime(row.startedAt)}</td>
              <td>{row.callerName || row.caller?.name || <span className="muted">Unknown</span>}<div className="muted co-num" style={{ fontSize: 12 }}>{row.fromNumber}</div></td>
              <td>{titleCase(row.callerType)}</td>
              <td>{row.intent ? titleCase(row.intent) : <span className="muted">—</span>}</td>
              <td><Badge tone={outcomeTone[row.outcome]}>{titleCase(row.outcome)}</Badge></td>
              <td className="co-num">{fmtDuration(row.durationMs)}</td>
              <td className="co-num">{row._count.turns}</td>
              <td className="co-num">{row.tickets.length ? row.tickets.map((t) => `#${t.number}`).join(", ") : <span className="muted">—</span>}</td>
              <td>{row.isTest ? <Badge tone="test">Test</Badge> : <Badge tone="live">Live</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && page && page.items.length === 0 && <div className="co-empty">No calls match these filters yet.</div>}
      {loading && !page && <div className="co-empty">Loading…</div>}
    </div>
  );
}

function CallsPage({ user, route, navigate, onAuthError }: { user: SessionUser; route: Route; navigate: (r: Route) => void; onAuthError: (e: unknown) => void }) {
  const [filters, setFilters] = useState({ isTest: "all", outcome: "", q: "", page: 1 });
  const list = useLoad<Paged<CallRow>>(
    () => api.calls({ ...filters, pageSize: 25 }).catch((e) => (onAuthError(e), Promise.reject(e))),
    [filters.isTest, filters.outcome, filters.q, filters.page]
  );
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  return (
    <>
      <div className="co-head">
        <div><h1>Calls</h1><p>{list.data ? `${list.data.total} calls` : ""}</p></div>
      </div>
      <div className="co-filters">
        <select className="co-select" value={filters.isTest} onChange={(e) => setFilters({ ...filters, isTest: e.target.value, page: 1 })}>
          <option value="all">Live + test</option><option value="false">Live only</option><option value="true">Test only</option>
        </select>
        <select className="co-select" value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value, page: 1 })}>
          <option value="">Any outcome</option>
          <option value="resolved_by_va">Resolved by agent</option>
          <option value="ticket_created">Ticket created</option>
          <option value="human_transfer">Transferred</option>
          <option value="abandoned">Abandoned</option>
          <option value="in_progress">In progress</option>
        </select>
        <input className="co-input" placeholder="Phone, name or ticket #" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value, page: 1 })} />
      </div>
      {list.error && <div className="co-error">{list.error}</div>}
      <CallsTable page={list.data} loading={list.loading} selectedId={route.id} onOpen={(id) => navigate({ page: "calls", id })} />
      <div className="co-pager">
        <span>Page {filters.page} of {pages}</span>
        <span>
          <button className="co-btn" disabled={filters.page <= 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>Previous</button>{" "}
          <button className="co-btn" disabled={filters.page >= pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>Next</button>
        </span>
      </div>
      {route.id && <CallDrawer id={route.id} user={user} onClose={() => { navigate({ page: "calls" }); list.reload(); }} onAuthError={onAuthError} />}
    </>
  );
}

function Drawer({ title, subtitle, onClose, children }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="co-drawer-backdrop" onClick={onClose} />
      <aside className="co-drawer" role="dialog" aria-modal="true">
        <div className="co-drawer-head">
          <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <button className="co-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="co-drawer-body">{children}</div>
      </aside>
    </>
  );
}

function CallDrawer({ id, user, onClose, onAuthError }: { id: string; user: SessionUser; onClose: () => void; onAuthError: (e: unknown) => void }) {
  const call = useLoad<CallDetail>(() => api.call(id).catch((e) => (onAuthError(e), Promise.reject(e))), [id]);
  const [busy, setBusy] = useState(false);
  const c = call.data;
  const toggleTest = async () => {
    if (!c) return;
    setBusy(true);
    try {
      await api.patchCall(c.id, { isTest: !c.isTest });
      call.reload();
    } finally {
      setBusy(false);
    }
  };
  const tools = useMemo(() => (c ? c.turns.flatMap((t) => (Array.isArray(t.toolCalls) ? (t.toolCalls as string[]) : [])) : []), [c]);
  return (
    <Drawer title={c ? c.callerName || c.caller?.name || "Unknown caller" : "Call"} subtitle={c ? `${c.fromNumber} · ${fmtTime(c.startedAt)} · ${fmtDuration(c.durationMs)}` : undefined} onClose={onClose}>
      {call.error && <div className="co-error">{call.error}</div>}
      {c && (
        <>
          <div className="co-filters">
            <Badge tone={outcomeTone[c.outcome]}>{titleCase(c.outcome)}</Badge>
            <Badge>{titleCase(c.status)}</Badge>
            {c.isTest ? <Badge tone="test">Test call</Badge> : <Badge tone="live">Live call</Badge>}
            {atLeast(user, "SUPERVISOR") && (
              <button className="co-btn" disabled={busy} onClick={toggleTest}>{c.isTest ? "Mark as live" : "Mark as test"}</button>
            )}
          </div>
          <section className="co-section">
            <h3>Call details</h3>
            <div className="co-meta">
              <div><span>Caller type</span><b>{titleCase(c.callerType)}</b></div>
              <div><span>Intent</span><b>{c.intent ? titleCase(c.intent) : "—"}</b></div>
              <div><span>Channel</span><b>{titleCase(c.provider)} · {titleCase(c.direction)}</b></div>
              <div><span>Agent</span><b>{c.agent?.name ?? "—"}</b></div>
              <div><span>Language</span><b>{c.language ?? "—"}</b></div>
              <div><span>Tools used</span><b>{tools.length ? [...new Set(tools)].join(", ") : "none"}</b></div>
              {c.escalationReason && <div style={{ gridColumn: "1 / -1" }}><span>Escalation reason</span><b>{c.escalationReason}</b></div>}
              {Object.entries(c.collected ?? {}).map(([key, value]) => (
                <div key={key}><span>{titleCase(key)}</span><b>{value}</b></div>
              ))}
            </div>
          </section>
          <section className="co-section">
            <h3>Tickets</h3>
            {c.tickets.length === 0 ? <p className="co-hint">No ticket was raised on this call.</p> : (
              <div className="co-tablewrap"><table className="co-table"><tbody>
                {c.tickets.map((t) => (
                  <tr key={t.id} className="row" onClick={() => { location.hash = `#/tickets/${t.id}`; }}>
                    <td className="co-num">#{t.number}</td><td>{titleCase(t.intent)}</td><td><Badge tone={ticketTone[t.status]}>{titleCase(t.status)}</Badge></td><td>{t.assignee?.name ?? <span className="muted">Unassigned</span>}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </section>
          <section className="co-section">
            <h3>Transcript</h3>
            {c.utterances.length === 0 ? <p className="co-hint">No transcript was stored for this call.</p> : (
              <div className="co-transcript">
                {c.utterances.map((u) => (
                  <div key={u.id} className={`co-bubble ${u.speaker === "AGENT" ? "agent" : "caller"}`}>
                    <small>{u.speaker === "AGENT" ? "Agent" : "Caller"}{u.atMs !== null ? ` · ${fmtDuration(u.atMs)}` : ""}</small>
                    {u.text}
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="co-section">
            <h3>Latency per turn</h3>
            <div className="co-tablewrap"><table className="co-table">
              <thead><tr><th>#</th><th>ASR</th><th>First token</th><th>LLM total</th><th>TTS first byte</th><th>Time to first word</th><th>Source</th></tr></thead>
              <tbody>
                {c.turns.map((t) => (
                  <tr key={t.id}>
                    <td className="co-num">{t.index}{t.interrupted ? " ⏹" : ""}</td>
                    <td className="co-num">{fmtMs(t.asrMs)}</td><td className="co-num">{fmtMs(t.llmFirstTokenMs)}</td><td className="co-num">{fmtMs(t.llmTotalMs)}</td><td className="co-num">{fmtMs(t.ttsFirstByteMs)}</td><td className="co-num">{fmtMs(t.ttfwMs)}</td><td>{t.source ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </section>
        </>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

function TicketsPage({ user, route, navigate, onAuthError }: { user: SessionUser; route: Route; navigate: (r: Route) => void; onAuthError: (e: unknown) => void }) {
  const [filters, setFilters] = useState({ status: "open", assigneeId: "", q: "", page: 1 });
  const list = useLoad<Paged<TicketRow>>(
    () => api.tickets({ ...filters, pageSize: 25 }).catch((e) => (onAuthError(e), Promise.reject(e))),
    [filters.status, filters.assigneeId, filters.q, filters.page]
  );
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  return (
    <>
      <div className="co-head"><div><h1>Tickets</h1><p>{list.data ? `${list.data.total} tickets` : ""}</p></div></div>
      <div className="co-filters">
        <select className="co-select" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value, page: 1 })}>
          <option value="open">Open</option><option value="">All</option><option value="resolved">Resolved</option><option value="closed">Closed</option>
        </select>
        <select className="co-select" value={filters.assigneeId} onChange={(e) => setFilters({ ...filters, assigneeId: e.target.value, page: 1 })}>
          <option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option>
        </select>
        <input className="co-input" placeholder="Phone, name, summary or #" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value, page: 1 })} />
      </div>
      {list.error && <div className="co-error">{list.error}</div>}
      <div className="co-tablewrap">
        <table className="co-table">
          <thead><tr><th>#</th><th>Raised</th><th>Caller</th><th>Intent</th><th>Summary</th><th>Priority</th><th>Status</th><th>Assignee</th></tr></thead>
          <tbody>
            {list.data?.items.map((t) => (
              <tr key={t.id} className={`row ${route.id === t.id ? "selected" : ""}`} onClick={() => navigate({ page: "tickets", id: t.id })}>
                <td className="co-num">#{t.number}</td>
                <td className="co-num">{fmtTime(t.createdAt)}</td>
                <td>{t.callerName || t.caller?.name || <span className="muted">Unknown</span>}<div className="muted co-num" style={{ fontSize: 12 }}>{t.phone}</div></td>
                <td>{titleCase(t.intent)}</td>
                <td style={{ whiteSpace: "normal", maxWidth: 360 }}>{t.summary}</td>
                <td><Badge tone={t.priority === "HIGH" ? "bad" : t.priority === "MEDIUM" ? "warn" : ""}>{titleCase(t.priority)}</Badge></td>
                <td><Badge tone={ticketTone[t.status]}>{titleCase(t.status)}</Badge></td>
                <td>{t.assignee?.name ?? <span className="muted">Unassigned</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.loading && list.data && list.data.items.length === 0 && <div className="co-empty">Nothing in this queue.</div>}
      </div>
      <div className="co-pager">
        <span>Page {filters.page} of {pages}</span>
        <span>
          <button className="co-btn" disabled={filters.page <= 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>Previous</button>{" "}
          <button className="co-btn" disabled={filters.page >= pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>Next</button>
        </span>
      </div>
      {route.id && <TicketDrawer id={route.id} user={user} onClose={() => { navigate({ page: "tickets" }); list.reload(); }} onAuthError={onAuthError} />}
    </>
  );
}

const toLocalInput = (iso: string | null): string => (iso ? new Date(iso).toISOString().slice(0, 16) : "");
const fromLocalInput = (value: string): string | null => (value ? new Date(value).toISOString() : null);

function TicketDrawer({ id, user, onClose, onAuthError }: { id: string; user: SessionUser; onClose: () => void; onAuthError: (e: unknown) => void }) {
  const ticket = useLoad<TicketDetail>(() => api.ticket(id).catch((e) => (onAuthError(e), Promise.reject(e))), [id]);
  const users = useLoad<UserRow[]>(() => (atLeast(user, "SUPERVISOR") ? api.users().catch(() => []) : Promise.resolve([])), [user.role]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = ticket.data;
  const canWork = atLeast(user, "AGENT") && (atLeast(user, "SUPERVISOR") || !t?.assigneeId || t.assigneeId === user.id);

  const patch = async (body: Parameters<typeof api.patchTicket>[1]) => {
    if (!t) return;
    setBusy(true);
    setError(null);
    try {
      await api.patchTicket(t.id, body);
      ticket.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the ticket");
    } finally {
      setBusy(false);
    }
  };

  const addNote = async (event: FormEvent) => {
    event.preventDefault();
    if (!t || !note.trim()) return;
    setBusy(true);
    try {
      await api.addNote(t.id, note.trim());
      setNote("");
      ticket.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the note");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title={t ? `Ticket #${t.number} · ${titleCase(t.intent)}` : "Ticket"} subtitle={t ? `${t.callerName || "Unknown caller"} · ${t.phone} · raised ${fmtTime(t.createdAt)}` : undefined} onClose={onClose}>
      {ticket.error && <div className="co-error">{ticket.error}</div>}
      {error && <div className="co-error">{error}</div>}
      {t && (
        <>
          <section className="co-section">
            <h3>Summary</h3>
            <div className="co-note">{t.summary}</div>
          </section>
          <section className="co-section">
            <h3>Work the ticket</h3>
            <div className="co-form-row">
              <label>Status
                <select className="co-select" value={t.status} disabled={!canWork || busy} onChange={(e) => patch({ status: e.target.value as TicketStatus })}>
                  {(["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"] as TicketStatus[]).map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
                </select>
              </label>
              <label>Priority
                <select className="co-select" value={t.priority} disabled={!canWork || busy} onChange={(e) => patch({ priority: e.target.value as TicketRow["priority"] })}>
                  <option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option>
                </select>
              </label>
              <label>Assignee
                {atLeast(user, "SUPERVISOR") ? (
                  <select className="co-select" value={t.assigneeId ?? ""} disabled={busy} onChange={(e) => patch({ assigneeId: e.target.value || null })}>
                    <option value="">Unassigned</option>
                    {(users.data ?? []).filter((u) => u.active && u.role !== "VIEWER").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                ) : (
                  <span>
                    {t.assignee?.name ?? "Unassigned"}{" "}
                    {atLeast(user, "AGENT") && !t.assigneeId && <button className="co-btn" disabled={busy} onClick={() => patch({ assigneeId: user.id })}>Take it</button>}
                  </span>
                )}
              </label>
              <label>Callback from
                <input className="co-input" type="datetime-local" value={toLocalInput(t.callbackStart)} disabled={!canWork || busy} onChange={(e) => patch({ callbackStart: fromLocalInput(e.target.value) })} />
              </label>
              <label>Callback until
                <input className="co-input" type="datetime-local" value={toLocalInput(t.callbackEnd)} disabled={!canWork || busy} onChange={(e) => patch({ callbackEnd: fromLocalInput(e.target.value) })} />
              </label>
              <label>Resolution code
                <input className="co-input" defaultValue={t.resolutionCode ?? ""} placeholder="e.g. delivered, replaced, refunded" disabled={!canWork || busy} onBlur={(e) => { if (e.target.value !== (t.resolutionCode ?? "")) patch({ resolutionCode: e.target.value || null }); }} />
              </label>
            </div>
          </section>
          <section className="co-section">
            <h3>Linked call</h3>
            {t.call ? (
              <a className="co-btn" href={`#/calls/${t.call.id}`}>Open call from {fmtTime(t.call.startedAt)} · {titleCase(t.call.outcome)}</a>
            ) : <p className="co-hint">Raised without a call record.</p>}
          </section>
          <section className="co-section">
            <h3>Notes</h3>
            <div className="co-transcript">
              {t.notes.length === 0 && <p className="co-hint">No notes yet.</p>}
              {t.notes.map((n) => (
                <div key={n.id} className="co-note"><small>{n.author?.name ?? "System"} · {fmtTime(n.createdAt)}</small>{n.text}</div>
              ))}
            </div>
            {atLeast(user, "AGENT") && (
              <form onSubmit={addNote} style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <textarea className="co-textarea" placeholder="What did you do or find out?" value={note} onChange={(e) => setNote(e.target.value)} />
                <div><button className="co-btn primary" disabled={busy || !note.trim()}>Add note</button></div>
              </form>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------

function UsersPage({ me, onAuthError }: { me: SessionUser; onAuthError: (e: unknown) => void }) {
  const list = useLoad<UserRow[]>(() => api.users().catch((e) => (onAuthError(e), Promise.reject(e))), []);
  const [form, setForm] = useState({ email: "", name: "", role: "AGENT" as Role });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createUser(form);
      setForm({ email: "", name: "", role: "AGENT" });
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the user");
    } finally {
      setBusy(false);
    }
  };

  const update = async (id: string, body: { role?: Role; active?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      await api.patchUser(id, body);
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the user");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="co-head"><div><h1>Users</h1><p>People who can sign in to this console. They sign in with a code sent to their email.</p></div></div>
      {error && <div className="co-error">{error}</div>}
      <form className="co-filters" onSubmit={create}>
        <input className="co-input" placeholder="Email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input className="co-input" placeholder="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select className="co-select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
          <option value="VIEWER">Viewer</option><option value="AGENT">Agent</option><option value="SUPERVISOR">Supervisor</option><option value="ADMIN">Admin</option>
        </select>
        <button className="co-btn primary" disabled={busy}>Add user</button>
      </form>
      <div className="co-tablewrap">
        <table className="co-table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {list.data?.map((u) => (
              <tr key={u.id}>
                <td>{u.name}{u.id === me.id ? " (you)" : ""}</td>
                <td>{u.email}</td>
                <td>
                  <select className="co-select" value={u.role} disabled={busy || u.id === me.id} onChange={(e) => update(u.id, { role: e.target.value as Role })}>
                    <option value="VIEWER">Viewer</option><option value="AGENT">Agent</option><option value="SUPERVISOR">Supervisor</option><option value="ADMIN">Admin</option>
                  </select>
                </td>
                <td className="co-num">{fmtTime(u.lastLoginAt)}</td>
                <td>{u.active ? <Badge tone="ok">Active</Badge> : <Badge>Disabled</Badge>}</td>
                <td>{u.id !== me.id && <button className="co-btn" disabled={busy} onClick={() => update(u.id, { active: !u.active })}>{u.active ? "Disable" : "Enable"}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="co-hint" style={{ marginTop: 10 }}><BarChart3 size={12} style={{ verticalAlign: "-2px" }} /> Every sign-in, ticket change and export is recorded in the audit log.</p>
    </>
  );
}
