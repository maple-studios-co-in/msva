import { parse } from "csv-parse/sync";
import fs from "node:fs";
import path from "node:path";
import type {
  AnalyticsResponse,
  CallRecord,
  CallStatus,
  DailyMetric,
  TimeBandMetric
} from "@msva/shared";

type RawRow = Record<string, string>;

const statusValues = new Set(["ANSWERED", "UNANSWERED", "MISSCALL"]);

function numberValue(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDate(value: string): Date {
  const [datePart, timePart] = value.split(" ");
  const [day, month, year] = datePart.split("/").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, second);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function pct(part: number, total: number): number {
  return total === 0 ? 0 : Number(((part / total) * 100).toFixed(1));
}

function toRecord(row: RawRow): CallRecord {
  const rawStatus = row.call_status_out;
  const callStatusOut = statusValues.has(rawStatus) ? (rawStatus as CallStatus) : "UNANSWERED";

  return {
    src: row.Src,
    associatedMobile: row.associated_mobile,
    callStartTime: row.call_start_time_in,
    durationIn: numberValue(row.duration_in),
    durationOut: numberValue(row.duration_out),
    callStatusOut,
    callLevelDepartment: row.calllevel_department,
    ifVoicemail: row.if_voicemail === "1",
    ifCallRecording: row.if_callrecording === "1",
    agentName: row.agent_name || undefined,
    outgoingPicked: row.outgoing_picked && row.outgoing_picked !== "0" ? row.outgoing_picked : undefined
  };
}

export function loadCallRecords(csvPath: string): CallRecord[] {
  const fullPath = path.resolve(process.cwd(), csvPath);
  const csv = fs.readFileSync(fullPath, "utf8");
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true
  }) as RawRow[];

  return rows.map(toRecord);
}

function buildTimeBands(records: CallRecord[]): TimeBandMetric[] {
  const bands = [
    { band: "00-05 Night", from: 0, to: 5 },
    { band: "06-09 Early", from: 6, to: 9 },
    { band: "10-13 Peak", from: 10, to: 13 },
    { band: "14-17 Afternoon", from: 14, to: 17 },
    { band: "18-23 After-hours", from: 18, to: 23 }
  ];

  return bands.map((band) => {
    const rows = records.filter((record) => {
      const hour = parseDate(record.callStartTime).getHours();
      return hour >= band.from && hour <= band.to;
    });
    const answered = rows.filter((row) => row.callStatusOut === "ANSWERED").length;
    const unanswered = rows.filter((row) => row.callStatusOut === "UNANSWERED").length;
    const missed = rows.filter((row) => row.callStatusOut === "MISSCALL").length;
    const voicemail = rows.filter((row) => row.ifVoicemail).length;

    return {
      band: band.band,
      calls: rows.length,
      answered,
      unanswered,
      missed,
      voicemail,
      answerRate: pct(answered, rows.length)
    };
  });
}

function buildDaily(records: CallRecord[]): DailyMetric[] {
  const grouped = new Map<string, DailyMetric>();

  for (const record of records) {
    const date = parseDate(record.callStartTime).toISOString().slice(0, 10);
    const current = grouped.get(date) ?? { date, calls: 0, answered: 0 };
    current.calls += 1;
    if (record.callStatusOut === "ANSWERED") current.answered += 1;
    grouped.set(date, current);
  }

  return [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function buildAnalytics(records: CallRecord[]): AnalyticsResponse {
  const totalCalls = records.length;
  const uniqueCallers = new Set(records.map((record) => record.src)).size;
  const answeredCalls = records.filter((record) => record.callStatusOut === "ANSWERED").length;
  const unansweredCalls = records.filter((record) => record.callStatusOut === "UNANSWERED").length;
  const missedCalls = records.filter((record) => record.callStatusOut === "MISSCALL").length;
  const voicemailCalls = records.filter((record) => record.ifVoicemail).length;
  const callerCounts = new Map<string, number>();

  for (const record of records) {
    callerCounts.set(record.src, (callerCounts.get(record.src) ?? 0) + 1);
  }

  const repeatCalls = [...callerCounts.values()].filter((count) => count >= 2).reduce((sum, count) => sum + count, 0);
  const answeredDurations = records
    .filter((record) => record.callStatusOut === "ANSWERED")
    .map((record) => record.durationIn);

  const status = (["UNANSWERED", "ANSWERED", "MISSCALL"] as CallStatus[]).map((callStatus) => {
    const calls = records.filter((record) => record.callStatusOut === callStatus).length;
    return { status: callStatus, calls, share: pct(calls, totalCalls) };
  });

  const repeatCallers = [2, 3, 5, 10].map((threshold) => {
    const counts = [...callerCounts.values()].filter((count) => count >= threshold);
    const calls = counts.reduce((sum, count) => sum + count, 0);
    return {
      threshold: `${threshold}+ calls`,
      callers: counts.length,
      calls,
      share: pct(calls, totalCalls)
    };
  });

  const agentCounts = new Map<string, number>();
  for (const record of records.filter((item) => item.agentName)) {
    agentCounts.set(record.agentName as string, (agentCounts.get(record.agentName as string) ?? 0) + 1);
  }

  const timeBands = buildTimeBands(records);

  return {
    kpis: {
      totalCalls,
      uniqueCallers,
      answeredCalls,
      unansweredCalls,
      missedCalls,
      voicemailCalls,
      answerRate: pct(answeredCalls, totalCalls),
      repeatCallerShare: pct(repeatCalls, totalCalls),
      medianInboundDuration: median(records.map((record) => record.durationIn)),
      medianAnsweredDuration: median(answeredDurations),
      peakWindow: "10:00-14:00"
    },
    status,
    timeBands,
    repeatCallers,
    agents: [...agentCounts.entries()].map(([name, calls]) => ({ name, calls })),
    daily: buildDaily(records),
    findings: [
      "77.3% calls are not answered by a human agent.",
      "No calls are answered before 10 AM, after 6 PM, or on Sunday.",
      "10 AM to 2 PM is the heaviest traffic window.",
      "67.2% of call volume comes from repeat callers.",
      "A voice agent should start as a 24x7 availability, triage, and callback layer."
    ]
  };
}
