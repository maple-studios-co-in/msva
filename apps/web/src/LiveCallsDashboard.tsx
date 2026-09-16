import type { LiveCallRow, LiveCallsResponse } from "@msva/shared";
import { Activity, AlertTriangle, CheckCircle2, Clock, PhoneCall, RefreshCw, Ticket } from "lucide-react";
import { useEffect, useState } from "react";
import { getLiveCalls } from "./api";
import { usePollingLoad } from "./console/usePollingLoad";
import { callDuration, DEMO_START_KEY, formatCallTime, restoreDemoStart } from "./liveCalls";
import "./LiveCallsDashboard.css";

const statusLabels: Record<LiveCallRow["status"], string> = {
  QUEUED: "Queued", RINGING: "Ringing", IN_PROGRESS: "In progress",
  COMPLETED: "Completed", NO_ANSWER: "No answer", FAILED: "Failed"
};

function savedDemoStart(): string | null {
  try { return restoreDemoStart(localStorage.getItem(DEMO_START_KEY)); }
  catch { return null; }
}

const count = (value: number) => new Intl.NumberFormat("en-IN").format(value);

export function LiveCallsDashboard() {
  const [from, setFrom] = useState<string | null>(savedDemoStart);
  const [channel, setChannel] = useState<LiveCallsResponse["channel"]>("all");
  const [page, setPage] = useState(1);
  const [now, setNow] = useState(Date.now);
  const [storageWarning, setStorageWarning] = useState(false);
  const { data, error, loading, refreshing, reload } = usePollingLoad(
    (signal) => getLiveCalls({ from: from ?? undefined, channel, page, pageSize: 25 }, signal),
    [from, channel, page],
    { intervalMs: 5000, onError: () => {} }
  );

  const hasActiveCall = data?.items.some((call) => call.status === "IN_PROGRESS" && !call.endedAt);
  useEffect(() => {
    setNow(Date.now());
    if (!hasActiveCall) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveCall]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  useEffect(() => {
    if (data && page > totalPages) setPage(totalPages);
  }, [data, page, totalPages]);

  function changePeriod(value: string | null) {
    setFrom(value);
    setPage(1);
    try {
      if (value) localStorage.setItem(DEMO_START_KEY, value);
      else localStorage.removeItem(DEMO_START_KEY);
      setStorageWarning(false);
    } catch {
      setStorageWarning(true);
    }
  }

  const cards = data ? [
    { label: "Recorded calls", value: data.summary.totalCalls, icon: PhoneCall, helper: "Calls in this view" },
    { label: "Active now", value: data.summary.activeCalls, icon: Activity, helper: "Queued, ringing or in progress" },
    { label: "Completed calls", value: data.summary.completedCalls, icon: CheckCircle2, helper: "Calls that ended · not a resolution rate" },
    { label: "Tickets created", value: data.summary.tickets, icon: Ticket, helper: "Saved tickets linked to these calls" }
  ] : [];

  return (
    <section className="live-data" aria-labelledby="live-data-title">
      <div className="live-data-heading">
        <div>
          <p className="eyebrow">Recorded call activity</p>
          <h2 id="live-data-title">Live call data</h2>
          <p>Calls made during your demo appear here automatically. Caller numbers are masked.</p>
        </div>
        <a className="live-data-console" href="/console.html#/calls" target="_blank" rel="noreferrer">Open support console ↗</a>
      </div>

      <div className="live-data-toolbar">
        <div className="live-data-period" aria-label="Call time range">
          <button type="button" className={!from ? "selected" : ""} aria-pressed={!from} onClick={() => changePeriod(null)}>Today</button>
          <button type="button" className={from ? "selected" : ""} onClick={() => changePeriod(new Date().toISOString())}>
            {from ? "Start a new demo session" : "Start demo session"}
          </button>
        </div>
        <label className="live-data-filter">Channel
          <select value={channel} onChange={(event) => { setChannel(event.target.value as LiveCallsResponse["channel"]); setPage(1); }}>
            <option value="all">All channels</option>
            <option value="phone">Phone</option>
            <option value="browser">Browser</option>
          </select>
        </label>
        <button className="live-data-refresh" type="button" onClick={reload} disabled={loading || refreshing} aria-label="Refresh call data">
          <RefreshCw size={15} className={refreshing ? "spinning" : ""} /> Refresh
        </button>
      </div>

      <div className="live-data-context">
        <span><Clock size={14} /> {from ? `Demo session since ${formatCallTime(from)} IST` : "Today · midnight onwards, India time"}</span>
        <span>{data ? `Updates every 5 seconds · Last updated ${formatCallTime(data.updatedAt)} IST` : "Updates every 5 seconds"}</span>
      </div>
      <p className="live-data-help">Starting a demo session only filters this view; it keeps all call records. {from && "Your session filter is saved in this browser."}</p>
      {storageWarning && <p className="live-data-warning" role="status">This browser could not save the session filter. It may reset when you refresh the page.</p>}
      {error && (
        <div className="live-data-error" role="alert">
          <AlertTriangle size={18} />
          <span>{data ? "Updates are temporarily unavailable. Showing the last received call data." : "Call data is temporarily unavailable. Please retry."}</span>
          <button type="button" onClick={reload} disabled={refreshing}>Retry</button>
        </div>
      )}
      {loading && !data && <div className="loading" role="status">Loading recorded calls…</div>}

      {data && <>
        <div className="kpi-grid">
          {cards.map(({ label, value, icon: Icon, helper }) => (
            <div className="kpi-card" key={label}>
              <div className="kpi-icon"><Icon size={20} /></div>
              <div><p>{label}</p><strong>{count(value)}</strong><span>{helper}</span></div>
            </div>
          ))}
        </div>

        <div className="live-data-quality" aria-label="Call quality counts">
          <span><strong>{count(data.summary.failedCalls)}</strong> failed or unanswered calls</span>
          <span><strong>{count(data.summary.fallbackTurns)}</strong> fallback replies</span>
          <span><strong>{count(data.summary.recognitionRetries)}</strong> speech recognition retries</span>
        </div>

        <div className="panel live-data-table-panel">
          <div className="panel-head">
            <div><p className="eyebrow">Source: recorded calls</p><h2>{from ? "Demo session calls" : "Today’s calls"}</h2></div>
            <span className="badge">{count(data.total)} {data.total === 1 ? "call" : "calls"}</span>
          </div>
          {data.items.length === 0 ? (
            <div className="live-data-empty">
              <PhoneCall size={28} />
              <h3>No calls in this view yet</h3>
              <p>Make a phone or browser call. It will appear automatically when its call record reaches the service.</p>
              {channel !== "all" && <button type="button" onClick={() => { setChannel("all"); setPage(1); }}>Show all channels</button>}
            </div>
          ) : <div className="live-data-table-scroll" tabIndex={0} aria-label="Recorded calls table">
            <table className="live-data-table">
              <thead><tr>
                <th scope="col">Time (IST)</th><th scope="col">Caller</th><th scope="col">Channel</th><th scope="col">Status</th>
                <th scope="col">Duration</th><th scope="col">Turns</th><th scope="col">Tickets</th><th scope="col">Call quality</th>
              </tr></thead>
              <tbody>{data.items.map((call) => (
                <tr key={call.id}>
                  <td><time dateTime={call.startedAt}>{formatCallTime(call.startedAt)}</time></td>
                  <td>{call.caller}</td>
                  <td>{call.channel === "phone" ? "Phone" : "Browser"}{call.isTest && <span className="live-data-test">Test</span>}</td>
                  <td><span className={`live-data-status ${call.status.toLowerCase()}`}>{statusLabels[call.status]}</span></td>
                  <td className="live-data-duration">{callDuration(call, now)}</td>
                  <td>{count(call.turns)}</td><td>{count(call.tickets)}</td>
                  <td>{call.fallbackTurns || call.recognitionRetries ? <span className="live-data-warning">
                    {call.fallbackTurns > 0 && <span>{count(call.fallbackTurns)} fallback {call.fallbackTurns === 1 ? "reply" : "replies"}</span>}
                    {call.recognitionRetries > 0 && <span>{count(call.recognitionRetries)} recognition {call.recognitionRetries === 1 ? "retry" : "retries"}</span>}
                  </span> : <span className="live-data-muted">None recorded</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>}
          {data.total > 0 && <div className="live-data-pagination">
            <span>Page {data.page} of {totalPages} · {count(data.total)} calls</span>
            <div>
              <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || refreshing}>Previous</button>
              <button type="button" onClick={() => setPage((value) => value + 1)} disabled={page >= totalPages || refreshing}>Next</button>
            </div>
          </div>}
        </div>
        <p className="live-data-help">Test badges identify calls marked as tests. These are recorded sessions, separate from the illustrative figures under Sample analytics. Transcripts and full caller details are available in the signed-in support console.</p>
      </>}
    </section>
  );
}
