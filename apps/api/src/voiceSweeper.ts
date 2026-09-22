import { sweepVoiceSessions } from "./voiceService.js";

const POLL_MS = 60_000;

/** Runs the voice session sweep once a minute while voice is enabled. */
export function startVoiceSweeper(): { stop(): Promise<void> } {
  if (process.env.VOICE_ENABLED !== "true") return { async stop() {} };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      await sweepVoiceSessions();
    } catch (error) {
      console.error("[voice-sweeper] sweep failed", error instanceof Error ? error.name : "unknown error");
    } finally {
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
