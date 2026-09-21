import { runAssessmentTick } from "./assessmentJobs.js";

const POLL_MS = 2_500;

export function startAssessmentWorker(): { stop(): Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runAssessmentTick();
    } catch (error) {
      // The job state carries a sanitized failure reason. Do not log request
      // bodies or provider responses from a background loop.
      console.error("[assessment-worker] tick failed", error instanceof Error ? error.message : "unknown error");
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    }
  };
  void tick();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
    }
  };
}
