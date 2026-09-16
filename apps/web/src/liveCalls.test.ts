import { describe, expect, it } from "vitest";
import type { LiveCallRow } from "@msva/shared";
import { callDuration, formatCallTime, restoreDemoStart } from "./liveCalls";

const now = Date.parse("2026-09-16T10:00:00.000Z");
const call = (overrides: Partial<LiveCallRow> = {}): LiveCallRow => ({
  id: "call-1", startedAt: "2026-09-16T09:59:00.000Z", endedAt: null,
  channel: "phone", caller: "•••• 1234", status: "IN_PROGRESS", durationMs: null,
  turns: 2, tickets: 0, fallbackTurns: 0, recognitionRetries: 0, isTest: false,
  ...overrides
});

describe("demo session and recorded call display", () => {
  it("restores the exact session boundary across refreshes", () => {
    expect(restoreDemoStart("2026-09-16T09:57:43.123Z", now)).toBe("2026-09-16T09:57:43.123Z");
  });

  it.each([null, "", "not-a-date", "2026-09-17T09:57:43.123Z"])("ignores invalid or future saved sessions: %s", (saved) => {
    expect(restoreDemoStart(saved, now)).toBeNull();
  });

  it("shows actual elapsed duration while a call is in progress", () => {
    expect(callDuration(call(), now)).toBe("1:00 · ongoing");
    expect(callDuration(call({ durationMs: 1000 }), now + 9000)).toBe("1:09 · ongoing");
  });

  it("freezes completed durations and leaves unknown durations unclaimed", () => {
    expect(callDuration(call({ status: "COMPLETED", endedAt: "2026-09-16T09:59:42.000Z", durationMs: 42500 }), now)).toBe("0:42");
    expect(callDuration(call({ status: "FAILED" }), now)).toBe("—");
    expect(callDuration(call({ status: "RINGING" }), now)).toBe("—");
  });

  it("uses a recorded end even when the status is stale", () => {
    expect(callDuration(call({ endedAt: "2026-09-16T09:59:13.000Z" }), now)).toBe("0:13");
  });

  it("renders India time independently of the viewer timezone", () => {
    expect(formatCallTime("2026-09-16T20:00:00Z")).toContain("17 Sept");
    expect(formatCallTime("2026-09-16T20:00:00Z")).toContain("01:30:00");
  });
});
