import type { CallDetail } from "./api";

export const isCallActive = (call: Pick<CallDetail, "status" | "endedAt">): boolean =>
  !call.endedAt && ["QUEUED", "RINGING", "IN_PROGRESS"].includes(call.status);

export type LoadState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  updatedAt: number | null;
};

export type VisibilitySource = {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

export type PollingOptions<T> = {
  load: (signal: AbortSignal) => Promise<T>;
  onChange: (state: LoadState<T>) => void;
  onError?: (error: unknown) => void;
  intervalMs: number;
  shouldPoll?: (data: T) => boolean;
  visibility: VisibilitySource;
};

export function startPolling<T>(options: PollingOptions<T>) {
  let state: LoadState<T> = { data: null, error: null, loading: true, refreshing: false, updatedAt: null };
  let stopped = false;
  let pendingRefresh = false;
  let request: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const shouldPoll = () => state.data === null || !options.shouldPoll || options.shouldPoll(state.data);

  const run = async () => {
    if (stopped || options.visibility.hidden) return;
    if (request) {
      pendingRefresh = true;
      return;
    }
    clearTimer();
    pendingRefresh = false;
    request = new AbortController();
    state = { ...state, loading: state.data === null, refreshing: state.data !== null };
    options.onChange(state);
    try {
      const data = await options.load(request.signal);
      if (stopped) return;
      state = { ...state, data, error: null, updatedAt: Date.now() };
    } catch (error) {
      if (stopped) return;
      state = { ...state, error: error instanceof Error ? error.message : "Could not load updates" };
      options.onError?.(error);
    } finally {
      request = null;
      if (!stopped) {
        state = { ...state, loading: false, refreshing: false };
        options.onChange(state);
        if (!options.visibility.hidden) {
          if (pendingRefresh) void run();
          else if (shouldPoll()) timer = setTimeout(() => { void run(); }, options.intervalMs);
        }
      }
    }
  };

  const onVisibilityChange = () => {
    clearTimer();
    if (!options.visibility.hidden && (pendingRefresh || shouldPoll())) void run();
  };
  options.visibility.addEventListener("visibilitychange", onVisibilityChange);
  options.onChange(state);
  void run();

  return {
    refresh() {
      if (stopped) return;
      pendingRefresh = true;
      void run();
    },
    stop() {
      stopped = true;
      clearTimer();
      options.visibility.removeEventListener("visibilitychange", onVisibilityChange);
      request?.abort();
    }
  };
}
