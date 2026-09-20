import { useCallback, useEffect, useRef, useState } from "react";
import type { CallAssessmentDto, CallAssessmentResponse, CallAssessmentResult } from "@msva/shared";
import { api } from "./api";
import { AssessmentPollController } from "./assessmentPolling.js";
import { assessmentView, responseBelongsToCall, type AssessmentView } from "./assessmentView.js";

type Props = {
  callId: string;
  canAssess: boolean;
  savedCallRevision: string;
  refreshToken: number;
  onAuthError: (error: unknown) => void;
  onChanged: () => void;
};

export function CallAssessmentPanel({ callId, canAssess, savedCallRevision, refreshToken, onAuthError, onChanged }: Props) {
  const [response, setResponse] = useState<CallAssessmentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const poller = useRef<AssessmentPollController | null>(null);
  const postNumber = useRef(0);
  const lastRefreshTrigger = useRef<string | undefined>(undefined);
  const authError = useRef(onAuthError);
  authError.current = onAuthError;

  useEffect(() => {
    setLoading(true);
    setResponse(null);
    setError(null);
    lastRefreshTrigger.current = undefined;
    const controller = new AssessmentPollController({
      load: (signal) => api.callAssessment(callId, signal),
      onResponse: (next) => {
        if (!responseBelongsToCall(callId, callId, next)) return;
        setResponse(next);
        setError(null);
        setLoading(false);
        setNowMs(Date.now());
      },
      onReadError: (caught) => {
        authError.current(caught);
        setError("Assessment updates are temporarily unavailable.");
        setLoading(false);
      },
      onLeaseExpiry: () => {
        setNowMs(Date.now());
        setLoading(false);
      }
    });
    poller.current = controller;
    controller.start();
    return () => {
      controller.stop();
      if (poller.current === controller) poller.current = null;
      postNumber.current += 1;
    };
  }, [callId]);

  const refreshTrigger = `${savedCallRevision}:${refreshToken}`;
  useEffect(() => {
    if (lastRefreshTrigger.current !== undefined && lastRefreshTrigger.current !== refreshTrigger) poller.current?.refresh();
    lastRefreshTrigger.current = refreshTrigger;
  }, [refreshTrigger]);

  const view = response ? assessmentView(response, canAssess, new Date(nowMs)) : null;

  const assess = useCallback(async () => {
    const request = ++postNumber.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api.assessCall(callId);
      if (request !== postNumber.current || !responseBelongsToCall(callId, callId, next)) return;
      poller.current?.accept(next);
      onChanged();
    } catch (caught) {
      if (request !== postNumber.current) return;
      onAuthError(caught);
      setError("The assessment request could not be completed. Try again after reviewing the transcript.");
    } finally {
      if (request === postNumber.current) setBusy(false);
    }
  }, [callId, onAuthError, onChanged]);

  return (
    <section className="co-section co-assessment" aria-labelledby="assessment-heading">
      <h3 id="assessment-heading">Post-call assessment</h3>
      {loading && !response ? <p className="co-hint" aria-live="polite">Loading assessment…</p> : null}
      {error ? <p className="co-error" role="status">{error}</p> : null}
      {response && view ? <AssessmentContent response={response} view={view} busy={busy} onAssess={assess} /> : null}
    </section>
  );
}

export function AssessmentContent({ response, view, busy, onAssess }: {
  response: CallAssessmentResponse;
  view: AssessmentView;
  busy: boolean;
  onAssess: () => void;
}) {
  const result = view.showResult ? response.assessment?.result : null;
  return (
    <div className={`co-assessment-state ${view.kind}`} aria-live="polite">
      <strong>{view.headline}</strong>
      <p>{view.liveMessage ?? view.detail}</p>
      {view.actionLabel ? <><p className="co-hint">Sends this saved transcript to TypeSafe AI for advisory assessment.</p><button className="co-btn" type="button" disabled={busy || !view.canRequest} onClick={onAssess}>{busy ? "Requesting assessment…" : view.actionLabel}</button></> : null}
      {result && response.assessment ? <AssessmentResult assessment={response.assessment} result={result} /> : null}
    </div>
  );
}

function AssessmentResult({ assessment, result }: { assessment: CallAssessmentDto; result: CallAssessmentResult }) {
  const rows: Array<[string, string, number]> = [
    ["Repetition", choiceText(result.repetition.choice), result.repetition.confidence],
    ["Caller sentiment", choiceText(result.callerSentiment.choice), result.callerSentiment.confidence],
    ["Follow-up need", choiceText(result.followUpNeed.choice), result.followUpNeed.confidence],
    ["Ticket creation claim", choiceText(result.ticketCreationClaim.choice), result.ticketCreationClaim.confidence],
    ["Journey", choiceText(result.journey.choice), result.journey.confidence],
    ["Urgency", urgencyText(result.urgency.choice), result.urgency.confidence]
  ];
  return (
    <div className="co-assessment-result">
      <p className="co-hint">Advisory AI assessment — review the transcript. Probabilities are model estimates, not accuracy scores.</p>
      <div className="co-meta">
        {rows.map(([label, choice, confidence]) => (
          <div key={label}><span>{label}</span><b>{choice}</b><small>Model confidence: {Math.round(confidence * 100)}%</small></div>
        ))}
      </div>
      <div className="co-meta co-assessment-provenance">
        <div><span>Requested</span><b>{formatAssessmentTime(assessment.requestedAt)}</b></div>
        <div><span>Completed</span><b>{formatAssessmentTime(assessment.completedAt)}</b></div>
        <div><span>Requested model</span><b>{assessment.requestedModel}</b></div>
        <div><span>Returned model</span><b>{assessment.returnedModel ?? "Not recorded"}</b></div>
        <div><span>Rubric version</span><b>{assessment.rubricVersion}</b></div>
      </div>
      <p className="co-hint">{result.linkedTicketRecorded ? "Linked persisted ticket record" : "No linked persisted ticket record"}</p>
      {result.possibleUnsupportedTicketClaim ? <p className="co-hint">Possible unsupported ticket claim — review persisted ticket records.</p> : null}
    </div>
  );
}

const choiceText = (choice: string): string => choice.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

const urgencyText = (choice: CallAssessmentResult["urgency"]["choice"]): string => {
  if (choice === "possible_safety") return "Possible safety concern — review";
  if (choice === "routine") return "Routine classification";
  return "Urgency unclear";
};

const formatAssessmentTime = (iso: string | null): string => iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
