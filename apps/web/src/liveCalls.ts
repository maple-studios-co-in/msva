import type { LiveCallRow } from "@msva/shared";

export const DEMO_START_KEY = "msva.live-call-demo-start";

export function restoreDemoStart(value: string | null, now = Date.now()): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now ? new Date(timestamp).toISOString() : null;
}

export function formatCallTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date(value));
}

export function callDuration(call: LiveCallRow, now: number): string {
  const ongoing = call.status === "IN_PROGRESS" && !call.endedAt;
  const elapsed = ongoing
    ? now - Date.parse(call.startedAt)
    : call.durationMs ?? (call.endedAt ? Date.parse(call.endedAt) - Date.parse(call.startedAt) : null);
  if (elapsed === null || !Number.isFinite(elapsed)) return "—";
  const seconds = Math.floor(Math.max(0, elapsed) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}${ongoing ? " · ongoing" : ""}`;
}
