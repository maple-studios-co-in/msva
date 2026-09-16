import express from "express";
import type { AnalyticsResponse, CallRecord } from "@msva/shared";
import { buildAnalytics, loadCallRecords } from "./analytics.js";

type SampleSnapshot = { analytics: AnalyticsResponse; records: number };
type SampleStatus = "not_loaded" | "ready" | "unavailable";

function validSampleRecord(record: CallRecord): boolean {
  if (typeof record.src !== "string" || !record.src.trim() || typeof record.callStartTime !== "string") return false;
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(record.callStartTime);
  if (!match) return false;
  const [day, month, year, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
    && Number.isFinite(record.durationIn) && record.durationIn >= 0
    && Number.isFinite(record.durationOut) && record.durationOut >= 0;
}

/** Sample analytics are optional and must never gate live API startup/health. */
export function createSampleAnalytics(csvPath: string) {
  let snapshot: SampleSnapshot | null = null;
  let status: SampleStatus = "not_loaded";
  const router = express.Router();

  const load = (): SampleSnapshot => {
    if (snapshot) return snapshot;
    try {
      const records = loadCallRecords(csvPath);
      if (records.length === 0 || !records.every(validSampleRecord)) throw new Error("Invalid sample report");
      snapshot = { analytics: buildAnalytics(records), records: records.length };
      status = "ready";
      return snapshot;
    } catch (error) {
      status = "unavailable";
      snapshot = null;
      throw error;
    }
  };
  const unavailable = (response: express.Response) => {
    response.status(503).json({ error: "Sample analytics are unavailable. Recorded live calls are unaffected." });
  };

  router.use((_request, response, next) => { response.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/", (_request, response) => {
    try { response.json(load().analytics); }
    catch { unavailable(response); }
  });
  router.post("/reload", (_request, response) => {
    // A failed explicit reload must not keep returning the old report as current.
    snapshot = null;
    try { response.json({ ok: true, records: load().records }); }
    catch { unavailable(response); }
  });

  return {
    router,
    get status(): SampleStatus { return status; },
    get recordCount(): number | null { return snapshot?.records ?? null; }
  };
}
