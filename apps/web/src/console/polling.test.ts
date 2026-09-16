import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCallActive, startPolling, type LoadState } from "./polling";
import type { CallStatus } from "./api";

class Visibility extends EventTarget {
  hidden = false;

  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("console background refresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each<{ status: CallStatus; active: boolean }>([
    { status: "QUEUED", active: true },
    { status: "RINGING", active: true },
    { status: "IN_PROGRESS", active: true },
    { status: "COMPLETED", active: false },
    { status: "NO_ANSWER", active: false },
    { status: "FAILED", active: false }
  ])("refreshes $status calls only when still active", ({ status, active }) => {
    expect(isCallActive({ status, endedAt: null })).toBe(active);
  });

  it("does not keep polling an ended call with a stale in-progress status", () => {
    expect(isCallActive({ status: "IN_PROGRESS", endedAt: "2026-09-16T08:00:00.000Z" })).toBe(false);
  });

  it("keeps the displayed transcript while fetching the next snapshot", async () => {
    const next = deferred<string[]>();
    const states: LoadState<string[]>[] = [];
    let requests = 0;
    const polling = startPolling({
      load: async () => ++requests === 1 ? ["Hello"] : next.promise,
      onChange: (state) => states.push(state),
      intervalMs: 2500,
      visibility: new Visibility()
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({ data: ["Hello"], loading: false, refreshing: false });

    await vi.advanceTimersByTimeAsync(2500);
    expect(states.at(-1)).toMatchObject({ data: ["Hello"], loading: false, refreshing: true });
    next.resolve(["Hello", "I need help"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({ data: ["Hello", "I need help"], loading: false, refreshing: false });
    polling.stop();
  });

  it("never overlaps slow requests and coalesces manual refreshes", async () => {
    const pending = deferred<number>();
    const values: number[] = [];
    let requests = 0;
    const polling = startPolling({
      load: async () => ++requests === 1 ? pending.promise : requests,
      onChange: (state) => { if (state.data !== null && !state.refreshing) values.push(state.data); },
      intervalMs: 2500,
      visibility: new Visibility()
    });
    polling.refresh();
    polling.refresh();
    await vi.advanceTimersByTimeAsync(10000);
    expect(requests).toBe(1);
    pending.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toBe(2);
    expect(values).toEqual([1, 2]);
    polling.stop();
  });

  it("pauses in a hidden tab and refreshes immediately when visible again", async () => {
    const visibility = new Visibility();
    let requests = 0;
    let latest: number | null = null;
    const polling = startPolling({
      load: async () => ++requests,
      onChange: (state) => { latest = state.data; },
      intervalMs: 5000,
      visibility
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(latest).toBe(1);
    visibility.setHidden(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(requests).toBe(1);
    visibility.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(latest).toBe(2);
    polling.stop();
  });

  it("waits for visibility before starting a page opened in the background", async () => {
    const visibility = new Visibility();
    visibility.setHidden(true);
    let latest: string | null = null;
    const polling = startPolling({
      load: async () => "current call",
      onChange: (state) => { latest = state.data; },
      intervalMs: 2500,
      visibility
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(latest).toBeNull();
    visibility.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(latest).toBe("current call");
    polling.stop();
  });

  it("stops automatically once the call ends, including when returning to the tab", async () => {
    const visibility = new Visibility();
    const statuses: string[] = [];
    let requests = 0;
    const polling = startPolling({
      load: async () => ++requests === 1 ? "IN_PROGRESS" : "COMPLETED",
      onChange: (state) => { if (state.data && !state.refreshing) statuses.push(state.data); },
      intervalMs: 2500,
      shouldPoll: (status) => status === "IN_PROGRESS",
      visibility
    });
    await vi.advanceTimersByTimeAsync(30000);
    visibility.setHidden(true);
    visibility.setHidden(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(statuses).toEqual(["IN_PROGRESS", "COMPLETED"]);
    expect(requests).toBe(2);
    polling.stop();
  });

  it("retains the last successful data on error and clears the error after recovery", async () => {
    const states: LoadState<string>[] = [];
    const failures: unknown[] = [];
    const unavailable = new Error("Service unavailable");
    let requests = 0;
    const polling = startPolling({
      load: async () => { if (++requests === 2) throw unavailable; return `snapshot ${requests}`; },
      onChange: (state) => states.push(state),
      onError: (error) => failures.push(error),
      intervalMs: 5000,
      visibility: new Visibility()
    });
    await vi.advanceTimersByTimeAsync(0);
    const updatedAt = states.at(-1)?.updatedAt;
    await vi.advanceTimersByTimeAsync(5000);
    expect(states.at(-1)).toMatchObject({ data: "snapshot 1", error: "Service unavailable", loading: false, updatedAt });
    expect(failures).toEqual([unavailable]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(states.at(-1)).toMatchObject({ data: "snapshot 3", error: null, loading: false });
    polling.stop();
  });

  it("aborts on navigation and ignores late data or auth errors from the previous call", async () => {
    const pending = deferred<string>();
    const visibility = new Visibility();
    const states: LoadState<string>[] = [];
    const errors: unknown[] = [];
    let signal: AbortSignal | undefined;
    const polling = startPolling({
      load: (requestSignal) => { signal = requestSignal; return pending.promise; },
      onChange: (state) => states.push(state),
      onError: (error) => errors.push(error),
      intervalMs: 2500,
      visibility
    });
    polling.stop();
    const count = states.length;
    expect(signal?.aborted).toBe(true);
    pending.reject(new Error("Old session expired"));
    visibility.setHidden(true);
    visibility.setHidden(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(states).toHaveLength(count);
    expect(errors).toEqual([]);
  });

  it("does not overwrite the newly selected call with an older response", async () => {
    const oldCall = deferred<string>();
    let displayed: string | null = null;
    const options = {
      onChange: (state: LoadState<string>) => { displayed = state.data; },
      intervalMs: 2500,
      visibility: new Visibility()
    };
    const oldPolling = startPolling({ ...options, load: () => oldCall.promise });
    oldPolling.stop();
    const currentPolling = startPolling({ ...options, load: async () => "new call" });
    await vi.advanceTimersByTimeAsync(0);
    expect(displayed).toBe("new call");
    oldCall.resolve("old call");
    await vi.advanceTimersByTimeAsync(0);
    expect(displayed).toBe("new call");
    currentPolling.stop();
  });
});
