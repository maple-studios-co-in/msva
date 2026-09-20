import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallAssessmentResponse } from "@msva/shared";
import { AssessmentPollController } from "./assessmentPolling.js";
import { assessmentView } from "./assessmentView.js";

const ready = (): CallAssessmentResponse => ({
  capability: { enabled: true, available: true, reason: null },
  eligibility: { eligible: true, reason: null },
  assessment: null,
  current: true
});

const running = (leaseExpiresAt: string): CallAssessmentResponse => ({
  ...ready(),
  assessment: {
    id: "assessment-1", callId: "call-1", status: "RUNNING", requestedAt: "2026-09-21T10:00:00.000Z", completedAt: null,
    leaseExpiresAt, retryable: true, requestedModel: "jev-1.13.0", returnedModel: null, rubricVersion: "msva-post-call-v1", inputHash: "hash", errorCode: null, result: null
  }
});

const ineligible = (): CallAssessmentResponse => ({
  ...ready(), eligibility: { eligible: false, reason: "CALL_NOT_COMPLETED" }
});

afterEach(() => vi.useRealTimers());

describe("AssessmentPollController", () => {
  it("refreshes an active call after its saved completion without remounting", async () => {
    const load = vi.fn().mockResolvedValueOnce(ineligible()).mockResolvedValueOnce(ready());
    const changes: CallAssessmentResponse[] = [];
    const controller = new AssessmentPollController({ load, onResponse: (response) => changes.push(response), onReadError: () => {}, onLeaseExpiry: () => {} });

    controller.start();
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    controller.refresh();
    await vi.waitFor(() => expect(changes).toHaveLength(2));

    expect(changes.map((response) => response.eligibility.eligible)).toEqual([false, true]);
    controller.stop();
  });

  it("refreshes a current result to stale when saved transcript or evidence changes", async () => {
    const current = { ...ready(), assessment: { ...running("2026-09-21T10:01:00.000Z").assessment!, status: "SUCCEEDED", completedAt: "2026-09-21T10:00:05.000Z", leaseExpiresAt: null, result: null } };
    const stale = { ...current, current: false };
    const load = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(stale);
    const changes: CallAssessmentResponse[] = [];
    const controller = new AssessmentPollController({ load, onResponse: (response) => changes.push(response), onReadError: () => {}, onLeaseExpiry: () => {} });

    controller.start();
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    controller.refresh();
    await vi.waitFor(() => expect(changes).toHaveLength(2));

    expect(changes.at(-1)?.current).toBe(false);
    controller.stop();
  });

  it("retries a rejected poll while the lease remains active and recovers on the next read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T10:00:00.000Z"));
    const response = running("2026-09-21T10:00:20.000Z");
    const load = vi.fn().mockResolvedValueOnce(response).mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(ready());
    const changes: CallAssessmentResponse[] = [];
    const errors: unknown[] = [];
    const controller = new AssessmentPollController({ load, onResponse: (next) => changes.push(next), onReadError: (error) => errors.push(error), onLeaseExpiry: () => {} });

    controller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(2500);

    expect(errors).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(3);
    expect(changes.at(-1)).toEqual(ready());
    controller.stop();
  });

  it("expires a hanging poll independently and exposes the interrupted retry state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T10:00:00.000Z"));
    const response = running("2026-09-21T10:00:10.000Z");
    let pendingSignal: AbortSignal | undefined;
    const load = vi.fn()
      .mockResolvedValueOnce(response)
      .mockImplementationOnce((signal: AbortSignal) => new Promise<CallAssessmentResponse>(() => { pendingSignal = signal; }));
    const expiry = vi.fn();
    const controller = new AssessmentPollController({ load, onResponse: () => {}, onReadError: () => {}, onLeaseExpiry: expiry });

    controller.start();
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(7500);

    expect(expiry).toHaveBeenCalledTimes(1);
    expect(pendingSignal?.aborted).toBe(true);
    expect(assessmentView(response, true, new Date()).kind).toBe("interrupted");
    await vi.advanceTimersByTimeAsync(10000);
    expect(load).toHaveBeenCalledTimes(2);
    controller.stop();
  });
});
