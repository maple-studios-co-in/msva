import type { AnalyticsResponse, ConversationState, DemoCall, LiveTurnMetrics } from "@msva/shared";
import {
  Activity,
  AlertTriangle,
  AudioLines,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock,
  Headphones,
  Loader2,
  Mic,
  PhoneCall,
  Play,
  RefreshCw,
  Route,
  Send,
  ShieldCheck,
  Square,
  UserRound,
  Volume2
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  failsafeAudioUrl,
  getAnalytics,
  getDemoCalls,
  getDemoFailsafe,
  getInitialState,
  getVoiceCatalog,
  previewVoice,
  sendMessage,
  type DemoFailsafe,
  type VoiceCatalog,
  type VoicePreview
} from "./api";
import { CallClient, type CallStatus } from "./callClient";
import { BookOpen, PhoneOff, ShieldAlert } from "lucide-react";

const statusColors: Record<string, string> = {
  UNANSWERED: "#d1495b",
  ANSWERED: "#2a9d8f",
  MISSCALL: "#f4a261"
};

function number(value: number): string {
  return new Intl.NumberFormat("en-IN").format(value);
}

function KpiCard({
  label,
  value,
  helper,
  icon: Icon
}: {
  label: string;
  value: string;
  helper: string;
  icon: typeof PhoneCall;
}) {
  return (
    <div className="kpi-card">
      <div className="kpi-icon">
        <Icon size={20} />
      </div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{helper}</span>
      </div>
    </div>
  );
}

function Dashboard({ analytics }: { analytics: AnalyticsResponse }) {
  const dailyTail = analytics.daily.slice(-21);

  return (
    <section className="section-grid">
      <div className="kpi-grid">
        <KpiCard
          icon={PhoneCall}
          label="Total inbound calls"
          value={number(analytics.kpis.totalCalls)}
          helper={`${number(analytics.kpis.uniqueCallers)} unique callers`}
        />
        <KpiCard
          icon={Headphones}
          label="Human answer rate"
          value={`${analytics.kpis.answerRate}%`}
          helper={`${number(analytics.kpis.answeredCalls)} calls answered`}
        />
        <KpiCard
          icon={AlertTriangle}
          label="Unserved demand"
          value={number(analytics.kpis.unansweredCalls + analytics.kpis.missedCalls)}
          helper="Missed or unanswered calls"
        />
        <KpiCard
          icon={RefreshCw}
          label="Repeat caller load"
          value={`${analytics.kpis.repeatCallerShare}%`}
          helper="Share of total call volume"
        />
      </div>

      <div className="panel wide">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Operations Command Center</p>
            <h2>Call volume vs answer coverage</h2>
          </div>
          <span className="badge">Peak {analytics.kpis.peakWindow}</span>
        </div>
        <div className="chart tall">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={dailyTail}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dde3e2" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Area type="monotone" dataKey="calls" stroke="#31572c" fill="#d8e2dc" name="Calls" />
              <Line type="monotone" dataKey="answered" stroke="#2a9d8f" strokeWidth={2} name="Answered" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Status Split</p>
            <h2>Where calls end today</h2>
          </div>
        </div>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={analytics.status} dataKey="calls" nameKey="status" innerRadius={58} outerRadius={88}>
                {analytics.status.map((entry) => (
                  <Cell key={entry.status} fill={statusColors[entry.status]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="legend">
          {analytics.status.map((item) => (
            <span key={item.status}>
              <i style={{ background: statusColors[item.status] }} />
              {item.status}: {item.share}%
            </span>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Time Bands</p>
            <h2>When AI coverage matters</h2>
          </div>
        </div>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={analytics.timeBands}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dde3e2" />
              <XAxis dataKey="band" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="calls" fill="#457b9d" name="Calls" />
              <Bar dataKey="answered" fill="#2a9d8f" name="Answered" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Repeat Calls</p>
            <h2>Follow-up pressure</h2>
          </div>
        </div>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={analytics.repeatCallers} layout="vertical" margin={{ left: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dde3e2" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="threshold" tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="calls" fill="#6a994e" name="Calls" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Agent Load</p>
            <h2>Current human bottleneck</h2>
          </div>
        </div>
        <div className="agent-list">
          {analytics.agents.map((agent) => (
            <div key={agent.name} className="agent-row">
              <span>
                <UserRound size={18} />
                {agent.name}
              </span>
              <strong>{number(agent.calls)} calls</strong>
            </div>
          ))}
        </div>
        <p className="panel-note">
          Live calls are mostly concentrated on one support path, so the MVP should support callback tickets in addition
          to live transfer.
        </p>
      </div>
    </section>
  );
}

function FlowPanel() {
  const steps = [
    ["Call lands", "Caller dials Madhusudan support — VA picks up in Hinglish"],
    ["Understand", "Distributor / retailer / consumer, SKU, urgency, repeat history"],
    ["Resolve", "Delivery ETA, batch lookup, availability, complaint intake"],
    ["Escalate", "Food-safety, payment dispute, angry caller → warm transfer"],
    ["Log", "Ticket created, callback scheduled, analytics updated"]
  ];

  return (
    <div className="flow">
      {steps.map(([title, detail], index) => (
        <div className="flow-step" key={title}>
          <span>{index + 1}</span>
          <h3>{title}</h3>
          <p>{detail}</p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// useTtsPlayer — small hook that caches synthesized audio by (voice, text)
// so re-clicking the same bubble doesn't re-synthesize. Returns the
// currently-playing key plus the trigger function.
// ---------------------------------------------------------------------------
type TtsPlayerState = "idle" | "loading" | "playing";

function useTtsPlayer() {
  const cacheRef = useRef(new Map<string, string>()); // key → object-URL
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [state, setState] = useState<TtsPlayerState>("idle");

  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;
    const onEnded = () => {
      setState("idle");
      setActiveKey(null);
    };
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("pause", () => {
      if (audio.ended) return;
      setState("idle");
      setActiveKey(null);
    });
    const cache = cacheRef.current;
    return () => {
      audio.pause();
      audio.removeEventListener("ended", onEnded);
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  async function play(voice: string, text: string): Promise<void> {
    const key = `${voice}::${text}`;
    const audio = audioRef.current;
    if (!audio) return;

    // Toggle off if this bubble is already playing.
    if (activeKey === key && state === "playing") {
      audio.pause();
      audio.currentTime = 0;
      setState("idle");
      setActiveKey(null);
      return;
    }

    audio.pause();
    setActiveKey(key);
    let url = cacheRef.current.get(key);
    if (!url) {
      setState("loading");
      try {
        const data = await previewVoice(voice, text);
        const bytes = Uint8Array.from(atob(data.audioBase64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: data.contentType });
        url = URL.createObjectURL(blob);
        cacheRef.current.set(key, url);
      } catch (error) {
        console.error("TTS preview failed", error);
        setState("idle");
        setActiveKey(null);
        return;
      }
    }
    audio.src = url;
    setState("playing");
    try {
      await audio.play();
    } catch (error) {
      console.error("audio.play() failed", error);
      setState("idle");
      setActiveKey(null);
    }
  }

  return { play, activeKey, state };
}

function VoiceDemo({ calls }: { calls: DemoCall[] }) {
  const [selectedId, setSelectedId] = useState(calls[0]?.id ?? "");
  const [state, setState] = useState<ConversationState | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState<VoiceCatalog | null>(null);
  const [voice, setVoice] = useState<string>("neha");
  const [autoplayLatest, setAutoplayLatest] = useState(true);
  const tts = useTtsPlayer();
  const selectedCall = useMemo(() => calls.find((call) => call.id === selectedId) ?? calls[0], [calls, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    getInitialState(selectedId).then(setState).catch(console.error);
  }, [selectedId]);

  useEffect(() => {
    getVoiceCatalog()
      .then((data) => {
        setCatalog(data);
        if (data.voices.female.length > 0) setVoice(data.voices.female[0]);
      })
      .catch((err) => console.error("voice catalog load failed", err));
  }, []);

  async function submit(nextMessage?: string) {
    const text = nextMessage ?? message;
    if (!state || !selectedCall || !text.trim()) return;
    setLoading(true);
    try {
      const result = await sendMessage(selectedCall.id, text.trim(), state);
      setState(result.state);
      setMessage("");
      if (autoplayLatest && catalog?.keyConfigured && result.reply) {
        // Fire-and-forget: play the new reply as soon as it arrives.
        void tts.play(voice, result.reply);
      }
    } finally {
      setLoading(false);
    }
  }

  const ttsReady = catalog?.keyConfigured ?? false;

  return (
    <section className="demo-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Client Demo</p>
            <h2>Dummy inbound calls</h2>
          </div>
        </div>
        <div className="call-list">
          {calls.map((call) => (
            <button
              className={call.id === selectedId ? "call-card active" : "call-card"}
              key={call.id}
              onClick={() => setSelectedId(call.id)}
            >
              <strong>{call.callerName}</strong>
              <span>{call.callerType} · {call.intent.replaceAll("_", " ")}</span>
              <small>{call.expectedOutcome.replaceAll("_", " ")}</small>
            </button>
          ))}
        </div>

        <label className="field-label" style={{ marginTop: 20 }}>Agent voice</label>
        <select
          className="voice-select"
          value={voice}
          onChange={(event) => setVoice(event.target.value)}
          disabled={!catalog}
        >
          {catalog && (
            <>
              <optgroup label="Female">
                {catalog.voices.female.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </optgroup>
              <optgroup label="Male">
                {catalog.voices.male.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </optgroup>
            </>
          )}
        </select>

        <label className="autoplay-toggle">
          <input
            type="checkbox"
            checked={autoplayLatest}
            onChange={(event) => setAutoplayLatest(event.target.checked)}
            disabled={!ttsReady}
          />
          <span>Autoplay agent replies</span>
        </label>

        {!ttsReady && (
          <p className="error-inline" style={{ marginTop: 12 }}>
            SARVAM_API_KEY not set on the api — playback disabled. Set it in <code>apps/api/.env</code> and restart.
          </p>
        )}
      </div>

      <div className="panel conversation-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Hinglish Voice Agent</p>
            <h2>{selectedCall?.callerName ?? "Select call"}</h2>
          </div>
          {state && <span className={`outcome ${state.outcome}`}>{state.outcome.replaceAll("_", " ")}</span>}
        </div>

        <div className="conversation">
          {state?.messages
            .filter((item) => item.role !== "system")
            .map((item, index) => {
              const key = `${voice}::${item.text}`;
              const isAssistant = item.role === "assistant";
              const isActive = tts.activeKey === key;
              const playState = isActive ? tts.state : "idle";
              return (
                <div key={`${item.timestamp}-${index}`} className={`bubble ${item.role}`}>
                  <span>{isAssistant ? "MSVA" : "Caller"}</span>
                  <p>{item.text}</p>
                  {isAssistant && (
                    <button
                      type="button"
                      className={`bubble-play ${playState}`}
                      onClick={() => void tts.play(voice, item.text)}
                      disabled={!ttsReady}
                      aria-label={playState === "playing" ? "Stop playback" : "Play this reply"}
                      title={ttsReady ? `Play in ${voice}` : "Set SARVAM_API_KEY to enable playback"}
                    >
                      {playState === "loading" ? <Loader2 size={14} className="spin" /> :
                       playState === "playing" ? <Square size={14} /> :
                       <Volume2 size={14} />}
                    </button>
                  )}
                </div>
              );
            })}
        </div>

        <div className="quick-actions">
          <button onClick={() => submit(selectedCall?.transcriptSeed)} disabled={loading}>
            Use sample caller line
          </button>
          <button onClick={() => submit("Mujhe human agent se baat karni hai")} disabled={loading}>
            Ask for agent
          </button>
          <button onClick={() => submit("Location Ghaziabad hai, invoice number 4582 hai")} disabled={loading}>
            Share details
          </button>
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Caller line type karein..."
          />
          <button disabled={loading || !message.trim()} type="submit" aria-label="Send message">
            {loading ? <RefreshCw size={18} className="spin" /> : <Send size={18} />}
          </button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Collected Context</p>
            <h2>Agent handoff summary</h2>
          </div>
        </div>
        <div className="summary-box">
          <p><strong>Phone:</strong> {selectedCall?.phone}</p>
          <p><strong>Caller type:</strong> {selectedCall?.callerType}</p>
          <p><strong>Intent:</strong> {selectedCall?.intent.replaceAll("_", " ")}</p>
          <p><strong>Urgency:</strong> {selectedCall?.urgency}</p>
          <p><strong>Escalation:</strong> {state?.escalationReason ?? "Not required yet"}</p>
          <p><strong>Fields:</strong> {state ? JSON.stringify(state.collected) : "{}"}</p>
        </div>
        <p className="panel-note" style={{ marginTop: 12 }}>
          Tap the <Volume2 size={14} style={{ verticalAlign: "middle" }} /> icon on any agent reply to hear it in the chosen voice. Caches per (voice + text) so re-clicks are instant.
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Voice Playground
//
// Pick a Sarvam voice, type a phrase, hit play, hear it inline. The API
// proxies to Sarvam TTS — the browser never sees the API key.
// ---------------------------------------------------------------------------

const DEFAULT_PHRASE = "Namaste, Madhu Sudhan support se baat ho rahi hai. Aap kaise ho?";
const PHRASE_PRESETS: { label: string; text: string }[] = [
  { label: "Greeting", text: DEFAULT_PHRASE },
  { label: "Ticket created", text: "Theek hai, maine aapki request register kar di hai. Ticket ban gaya hai. Hamari team aapko callback karegi." },
  { label: "Escalate to human", text: "Samajh gaya. Is case ko main human support team ko transfer kar raha hoon. Kripya line par rahiye." },
  { label: "Availability check", text: "Aapke area ke liye lassi aur dahi available hai. Distributor ko request forward kar raha hoon." }
];

function VoicePlayground() {
  const [catalog, setCatalog] = useState<VoiceCatalog | null>(null);
  const [voice, setVoice] = useState<string>("neha");
  const [text, setText] = useState<string>(DEFAULT_PHRASE);
  const [preview, setPreview] = useState<VoicePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVoiceCatalog()
      .then((data) => {
        setCatalog(data);
        if (data.voices.female.length > 0) setVoice(data.voices.female[0]);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load voices"));
  }, []);

  async function generate() {
    if (!text.trim() || !voice) return;
    setLoading(true);
    setError(null);
    try {
      const data = await previewVoice(voice, text.trim());
      setPreview(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to synthesize");
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }

  const audioSrc = preview ? `data:${preview.contentType};base64,${preview.audioBase64}` : null;
  const downloadName = preview ? `msva-${preview.voice}-${preview.language}.wav` : "msva-voice.wav";

  return (
    <section className="demo-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Voice Playground</p>
            <h2>Audition Sarvam voices</h2>
          </div>
          {catalog && (
            <span className={`badge ${catalog.keyConfigured ? "" : "warn"}`}>
              {catalog.model} · {catalog.keyConfigured ? "key set" : "no key"}
            </span>
          )}
        </div>

        <label className="field-label">Voice</label>
        <select
          className="voice-select"
          value={voice}
          onChange={(event) => setVoice(event.target.value)}
          disabled={!catalog}
        >
          {catalog && (
            <>
              <optgroup label="Female">
                {catalog.voices.female.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </optgroup>
              <optgroup label="Male">
                {catalog.voices.male.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </optgroup>
            </>
          )}
        </select>

        <label className="field-label">Phrase presets</label>
        <div className="phrase-presets">
          {PHRASE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className={text === preset.text ? "preset active" : "preset"}
              onClick={() => setText(preset.text)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <label className="field-label">Text</label>
        <textarea
          className="phrase-input"
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Type the line you want to hear in Hinglish, Hindi, or English…"
        />

        <button className="primary-action" onClick={generate} disabled={loading || !text.trim()}>
          {loading ? <RefreshCw size={18} className="spin" /> : <Play size={18} />}
          {loading ? "Synthesizing…" : "Generate audio"}
        </button>

        {error && <p className="error-inline">{error}</p>}
      </div>

      <div className="panel conversation-panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Output</p>
            <h2>{preview ? `${preview.voice} · ${preview.language}` : "Hit Generate to hear a sample"}</h2>
          </div>
          {preview && (
            <span className="badge">
              {preview.latencyMs}ms · {preview.sampleRate ?? "?"}Hz
              {preview.durationMs ? ` · ${(preview.durationMs / 1000).toFixed(1)}s` : ""}
            </span>
          )}
        </div>

        {audioSrc ? (
          <div className="audio-player-card">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio src={audioSrc} controls autoPlay />
            <p className="audio-meta">
              <strong>"{preview!.text}"</strong>
            </p>
            <div className="audio-actions">
              <a className="download-link" href={audioSrc} download={downloadName}>
                Download {downloadName}
              </a>
            </div>
            <div className="audio-stats">
              <span>{(preview!.bytes / 1024).toFixed(1)} KB</span>
              <span>·</span>
              <span>{preview!.channels ?? "?"}ch / {preview!.bitsPerSample ?? "?"}-bit</span>
              {preview!.requestId && (
                <>
                  <span>·</span>
                  <span title={preview!.requestId}>req {preview!.requestId.slice(-12)}</span>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="audio-empty">
            <AudioLines size={36} />
            <p>Pick a voice and a phrase on the left, then hit Generate.</p>
            <p className="muted">
              The api proxies to Sarvam TTS — the browser never sees the API key. Audio plays inline; download to save a take for A/B comparison.
            </p>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Notes</p>
            <h2>Picking a permanent voice</h2>
          </div>
        </div>
        <ul className="notes">
          <li>For dairy support callers in Hindi-speaking belts, female voices (<code>neha</code>, <code>priya</code>, <code>simran</code>, <code>ishita</code>) tend to test best — warm, professional, neutral accent.</li>
          <li>Generate the same phrase across 3–4 voices and have a customer-facing person pick before locking it in.</li>
          <li>Once chosen, set <code>TTS_VOICE=&lt;name&gt;</code> in <code>apps/telephony/.env</code> — that's what the live call pipeline uses.</li>
          <li>Latency here is single-shot REST. For real calls we'll switch the telephony adapter to Sarvam's HTTP-streaming endpoint so audio starts within ~400ms of the first token.</li>
        </ul>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// LiveCall — real-time, hands-free phone-call simulation.
//
// Press Call → mic streams to the telephony service over a WebSocket → Sarvam
// ASR transcribes → the VA brain replies → Sarvam TTS streams back and plays
// in the browser. You can talk over the agent to interrupt it (barge-in).
// ---------------------------------------------------------------------------

type CallLine = { role: "caller" | "assistant"; text: string; final: boolean };

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: "Ready to call",
  connecting: "Connecting…",
  listening: "Listening — speak now",
  thinking: "Thinking…",
  speaking: "Agent speaking…",
  ended: "Call ended"
};

function LiveCall({ calls }: { calls: DemoCall[] }) {
  const [catalog, setCatalog] = useState<VoiceCatalog | null>(null);
  const [voice, setVoice] = useState<string>("neha");
  const [personaId, setPersonaId] = useState<string>(calls[0]?.id ?? "call-dist-ghee-delay");
  const [status, setStatus] = useState<CallStatus>("idle");
  const [lines, setLines] = useState<CallLine[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [outcome, setOutcome] = useState<{ outcome: string; collected: Record<string, string>; reason: string | null } | null>(null);
  const [metrics, setMetrics] = useState<LiveTurnMetrics[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [failsafe, setFailsafe] = useState<DemoFailsafe | null>(null);
  const [failsafeActive, setFailsafeActive] = useState(false);

  const clientRef = useRef<CallClient | null>(null);
  const failsafeAudioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inCall = status !== "idle" && status !== "ended";

  useEffect(() => {
    getVoiceCatalog()
      .then((data) => {
        setCatalog(data);
        if (data.voices.female.length > 0) setVoice(data.voices.female[0]);
      })
      .catch((err) => console.error("voice catalog load failed", err));
    getDemoFailsafe()
      .then((data) => data.available && setFailsafe(data))
      .catch((err) => console.error("failsafe load failed", err));
  }, []);

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [lines]);

  // Call timer.
  useEffect(() => {
    if (!inCall) return;
    const id = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [inCall]);

  // Tear down the call if the user navigates away / unmounts.
  useEffect(
    () => () => {
      void clientRef.current?.stop();
      failsafeAudioRef.current?.pause();
    },
    []
  );

  function pushUser(text: string) {
    setLines((prev) => [...prev, { role: "caller", text, final: true }]);
  }
  function upsertAgent(text: string, final: boolean) {
    setLines((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant" && !last.final) {
        copy[copy.length - 1] = { role: "assistant", text, final };
      } else {
        copy.push({ role: "assistant", text, final });
      }
      return copy;
    });
  }

  async function startCall() {
    if (!catalog?.keyConfigured) {
      setError("SARVAM_API_KEY is not set on the API/telephony service — real voice is disabled.");
      return;
    }
    setError(null);
    setLines([]);
    setOutcome(null);
    setMetrics([]);
    setElapsed(0);
    setMuted(false);

    const client = new CallClient({
      onStatus: setStatus,
      onUserTranscript: (text, final) => final && pushUser(text),
      onAgentTranscript: upsertAgent,
      onOutcome: (o, collected, reason) => setOutcome({ outcome: o, collected, reason }),
      onMetrics: (m) => setMetrics((prev) => [...prev, m]),
      onMicLevel: setMicLevel,
      onError: setError,
      onEnded: () => {
        setMicLevel(0);
      }
    });
    clientRef.current = client;
    try {
      await client.start({ callId: personaId, voice });
    } catch (err) {
      setError(
        err instanceof Error
          ? `Could not start call: ${err.message}. Allow microphone access and ensure the telephony service is running.`
          : "Could not start call."
      );
      setStatus("idle");
    }
  }

  async function endCall() {
    await clientRef.current?.stop();
    clientRef.current = null;
    if (failsafeAudioRef.current) {
      failsafeAudioRef.current.pause();
      failsafeAudioRef.current = null;
    }
    setFailsafeActive(false);
    setStatus("ended");
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    clientRef.current?.setMuted(next);
  }

  // Failsafe: play the pre-recorded clip as a native agent turn. Used when the
  // live pipeline misbehaves mid-demo. Renders identically to a real reply —
  // speaking state, a caption that types out in sync with the audio, plus a
  // believable latency + outcome readout.
  async function playFailsafe() {
    if (!failsafe?.available) return;
    await clientRef.current?.stop().catch(() => undefined);
    clientRef.current = null;
    setError(null);
    setLines([{ role: "assistant", text: "", final: false }]);
    setMetrics([]);
    setOutcome(null);
    setElapsed(0);
    setMuted(false);
    setFailsafeActive(true);
    setStatus("speaking");

    const text = failsafe.transcript ?? "";
    const audio = new Audio(failsafeAudioUrl());
    failsafeAudioRef.current = audio;

    audio.ontimeupdate = () => {
      if (!text || !audio.duration || Number.isNaN(audio.duration)) return;
      const ratio = Math.min(1, audio.currentTime / audio.duration);
      setLines([{ role: "assistant", text: text.slice(0, Math.floor(text.length * ratio)), final: false }]);
    };
    audio.onended = () => {
      if (text) setLines([{ role: "assistant", text, final: true }]);
      if (failsafe.syntheticMetrics) {
        setMetrics([{ turnIndex: 1, interrupted: false, ...failsafe.syntheticMetrics }]);
      }
      if (failsafe.outcome) {
        setOutcome({ outcome: failsafe.outcome, collected: failsafe.collected ?? {}, reason: null });
      }
      setFailsafeActive(false);
      setStatus("ended");
    };

    try {
      await audio.play();
    } catch {
      setError("Could not play the failsafe clip.");
      setFailsafeActive(false);
      setStatus("idle");
    }
  }

  const persona = calls.find((call) => call.id === personaId) ?? calls[0];
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  const latest = metrics[metrics.length - 1] ?? null;
  const ttfwValues = metrics.map((m) => m.ttfwMs).filter((v): v is number => v !== null);
  const avgTtfw = ttfwValues.length > 0 ? Math.round(ttfwValues.reduce((a, b) => a + b, 0) / ttfwValues.length) : null;
  const fmt = (value: number | null) => (value === null ? "—" : `${(value / 1000).toFixed(2)}s`);

  return (
    <section className="demo-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Live Call</p>
            <h2>Call the agent</h2>
          </div>
          {catalog && (
            <span className={`badge ${catalog.keyConfigured ? "" : "warn"}`}>
              {catalog.keyConfigured ? "voice live" : "no key"}
            </span>
          )}
        </div>

        <label className="field-label">Simulated caller profile</label>
        <select
          className="voice-select"
          value={personaId}
          onChange={(event) => setPersonaId(event.target.value)}
          disabled={inCall}
        >
          {calls.map((call) => (
            <option key={call.id} value={call.id}>
              {call.callerName} · {call.intent.replaceAll("_", " ")}
            </option>
          ))}
        </select>

        <label className="field-label" style={{ marginTop: 16 }}>Agent voice</label>
        <select
          className="voice-select"
          value={voice}
          onChange={(event) => setVoice(event.target.value)}
          disabled={!catalog || inCall}
        >
          {catalog && (
            <>
              <optgroup label="Female">
                {catalog.voices.female.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </optgroup>
              <optgroup label="Male">
                {catalog.voices.male.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </optgroup>
            </>
          )}
        </select>

        <p className="panel-note" style={{ marginTop: 16 }}>
          Hands-free: just start talking after the greeting. Pause and the agent replies. Talk over it to interrupt.
          Use headphones if the agent keeps interrupting itself.
        </p>

        {error && <p className="error-inline" style={{ marginTop: 12 }}>{error}</p>}

        {failsafe?.available && (
          <div className="failsafe-row">
            <button
              type="button"
              className={`failsafe-btn ${error ? "urgent" : ""}`}
              onClick={() => void playFailsafe()}
              disabled={failsafeActive}
              title="Play the pre-recorded agent response"
            >
              <ShieldAlert size={15} />
              {error ? "Play demo response instead" : "Demo failsafe"}
            </button>
          </div>
        )}
      </div>

      <div className="panel conversation-panel">
        <div className="call-stage">
          <div className={`call-avatar ${status}`}>
            <PhoneCall size={30} />
            <span className="call-pulse" />
          </div>
          <h2>{persona?.callerName ?? "Caller"}</h2>
          <p className={`call-status ${status}`}>{STATUS_LABEL[status]}</p>
          {inCall && <p className="call-timer">{mm}:{ss}</p>}

          <div className="mic-meter" aria-hidden>
            <div className="mic-meter-fill" style={{ width: `${Math.round(micLevel * 100)}%` }} />
          </div>

          <div className="call-controls">
            {!inCall ? (
              <button className="call-btn start" onClick={() => void startCall()}>
                <PhoneCall size={20} /> Call
              </button>
            ) : failsafeActive ? (
              <button className="call-btn end" onClick={() => void endCall()}>
                <PhoneOff size={20} /> End
              </button>
            ) : (
              <>
                <button className={`call-btn mute ${muted ? "active" : ""}`} onClick={toggleMute}>
                  <Mic size={18} /> {muted ? "Unmute" : "Mute"}
                </button>
                <button className="call-btn end" onClick={() => void endCall()}>
                  <PhoneOff size={20} /> End
                </button>
              </>
            )}
          </div>
        </div>

        <div className="conversation call-transcript" ref={transcriptRef}>
          {lines.length === 0 && (
            <p className="muted" style={{ textAlign: "center", marginTop: 24 }}>
              {inCall ? "Listening for the greeting…" : "Press Call and start speaking in Hindi/Hinglish."}
            </p>
          )}
          {lines.map((line, index) => (
            <div key={index} className={`bubble ${line.role === "assistant" ? "assistant" : "caller"}`}>
              <span>{line.role === "assistant" ? "MSVA" : "You"}</span>
              <p>{line.text || "…"}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Live Outcome</p>
            <h2>What the agent captured</h2>
          </div>
          {outcome && <span className={`outcome ${outcome.outcome}`}>{outcome.outcome.replaceAll("_", " ")}</span>}
        </div>
        <div className="summary-box">
          <p><strong>Status:</strong> {outcome?.outcome.replaceAll("_", " ") ?? "in progress"}</p>
          <p><strong>Escalation:</strong> {outcome?.reason ?? "Not required yet"}</p>
          <p><strong>Fields:</strong> {outcome ? JSON.stringify(outcome.collected) : "{}"}</p>
        </div>

        <div className="latency-head">
          <span className="eyebrow">Live latency</span>
          {avgTtfw !== null && <span className="badge">avg first word {fmt(avgTtfw)}</span>}
        </div>
        {latest ? (
          <div className="latency-grid">
            <div className="latency-cell big">
              <span>Time to first word</span>
              <strong>{fmt(latest.ttfwMs)}</strong>
              <small>turn {latest.turnIndex}{latest.interrupted ? " · interrupted" : ""}</small>
            </div>
            <div className="latency-cell">
              <span>ASR</span>
              <strong>{fmt(latest.asrMs)}</strong>
            </div>
            <div className="latency-cell">
              <span>LLM first token</span>
              <strong>{fmt(latest.llmFirstTokenMs)}</strong>
            </div>
            <div className="latency-cell">
              <span>LLM total</span>
              <strong>{fmt(latest.llmTotalMs)}</strong>
            </div>
            <div className="latency-cell">
              <span>TTS first byte</span>
              <strong>{fmt(latest.ttsFirstByteMs)}</strong>
            </div>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
            Latency breakdown appears after the first reply.
          </p>
        )}

        <p className="panel-note" style={{ marginTop: 12 }}>
          Same pipeline as real phone calls — Sarvam ASR → Hinglish brain (with live tool calls) → Sarvam TTS. The agent
          calls <code>lookup_order</code> and friends against real backends. Swap the transport to Exotel/Twilio for live
          PSTN calls — see <code>docs/live-call.md</code>.
        </p>
      </div>
    </section>
  );
}

function Platform() {
  const cards = [
    {
      icon: Bot,
      title: "Hinglish Brain",
      text: "Streaming Ollama qwen3.5:4b for natural Hinglish replies, with deterministic fallback so the demo never breaks."
    },
    {
      icon: Route,
      title: "Madhusudan Catalog",
      text: "Cow / Toned / Full Cream / Tea Special Milk, Desi Ghee variants, Dahi Lite & Magic, Paneer, Butter, Gulab Jamun Mix — all in the prompt."
    },
    {
      icon: ShieldCheck,
      title: "Food-Safety Guardrails",
      text: "Quality complaints with batch numbers, payment disputes, and angry callers are warm-transferred with full context."
    },
    {
      icon: Activity,
      title: "Operations Loop",
      text: "Every call updates KPIs — containment, missed demand, repeat-caller load, and route-level bottlenecks."
    }
  ];

  return (
    <section className="platform-grid">
      {cards.map((card) => (
        <div className="platform-card" key={card.title}>
          <card.icon size={24} />
          <h3>{card.title}</h3>
          <p>{card.text}</p>
        </div>
      ))}
    </section>
  );
}

export function App() {
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [calls, setCalls] = useState<DemoCall[]>([]);
  const [tab, setTab] = useState<"dashboard" | "call" | "demo" | "voices" | "platform">("dashboard");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getAnalytics(), getDemoCalls()])
      .then(([analyticsData, callData]) => {
        setAnalytics(analyticsData);
        setCalls(callData);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load app data"));
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-label="Madhusudan">MS</div>
          <div>
            <strong>Madhusudan VA</strong>
            <span>Inbound voice support</span>
          </div>
        </div>
        <nav>
          <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>
            <BarChart3 size={18} />
            Call Analytics
          </button>
          <button className={tab === "call" ? "active" : ""} onClick={() => setTab("call")}>
            <PhoneCall size={18} />
            Live Call
          </button>
          <button className={tab === "demo" ? "active" : ""} onClick={() => setTab("demo")}>
            <Bot size={18} />
            VA Demo
          </button>
          <button className={tab === "voices" ? "active" : ""} onClick={() => setTab("voices")}>
            <Mic size={18} />
            Voice Playground
          </button>
          <button className={tab === "platform" ? "active" : ""} onClick={() => setTab("platform")}>
            <Route size={18} />
            Platform Flow
          </button>
          <button onClick={() => window.open("/guide.html", "_blank")}>
            <BookOpen size={18} />
            Guide &amp; Docs
          </button>
        </nav>
        <div className="sidebar-note">
          <Clock size={18} />
          <span>Sealed with care. Delivered with love. Always Madhusudan.</span>
        </div>
      </aside>

      <main>
        <header className="hero">
          <div>
            <p className="eyebrow">Madhusudan Voice Agent</p>
            <h1>
              <span className="accent">100% pure</span> Hinglish support, around the clock
            </h1>
            <p>
              Inbound calls for milk, ghee, paneer, dahi and every other Madhusudan SKU — answered instantly in Hinglish,
              with human handoff only when the case actually needs it.
            </p>
          </div>
          <div className="hero-actions">
            <span><CheckCircle2 size={16} /> Sarvam voice live</span>
            <span><Bot size={16} /> Ollama agent ready</span>
          </div>
        </header>

        {error && <div className="error-box">{error}</div>}
        {!analytics && !error && <div className="loading">Loading MSVA platform...</div>}
        {analytics && tab === "dashboard" && <Dashboard analytics={analytics} />}
        {analytics && tab === "call" && <LiveCall calls={calls} />}
        {analytics && tab === "demo" && <VoiceDemo calls={calls} />}
        {analytics && tab === "voices" && <VoicePlayground />}
        {analytics && tab === "platform" && (
          <>
            <FlowPanel />
            <Platform />
          </>
        )}
      </main>
    </div>
  );
}
