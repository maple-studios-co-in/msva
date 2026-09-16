import { useCallback, useEffect, useRef, useState } from "react";
import { startPolling, type LoadState } from "./polling";

type Options<T> = {
  intervalMs: number;
  onError: (error: unknown) => void;
  shouldPoll?: (data: T) => boolean;
};

// Only call views opt in. Ticket/user forms keep their existing explicit loads.
export function usePollingLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[], options: Options<T>) {
  const [state, setState] = useState<LoadState<T>>({ data: null, error: null, loading: true, refreshing: false, updatedAt: null });
  const current = useRef({ load, options });
  current.current = { load, options };
  const polling = useRef<ReturnType<typeof startPolling<T>> | null>(null);

  useEffect(() => {
    const controller = startPolling<T>({
      load: (signal) => current.current.load(signal),
      onChange: setState,
      onError: (error) => current.current.options.onError(error),
      shouldPoll: (data) => current.current.options.shouldPoll?.(data) ?? true,
      intervalMs: options.intervalMs,
      visibility: document
    });
    polling.current = controller;
    return () => {
      controller.stop();
      polling.current = null;
    };
    // The caller lists the query inputs, so an inline loader does not restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, options.intervalMs]);

  const reload = useCallback(() => polling.current?.refresh(), []);
  return { ...state, reload };
}
