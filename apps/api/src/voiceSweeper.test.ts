import { afterEach, expect, it, vi } from "vitest";

const { sweepVoiceSessions } = vi.hoisted(() => ({ sweepVoiceSessions: vi.fn(async () => 0) }));
vi.mock("./voiceService.js", () => ({ sweepVoiceSessions }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sweepVoiceSessions.mockReset();
  sweepVoiceSessions.mockImplementation(async () => 0);
  vi.resetModules();
});

it("does nothing while voice is disabled", async () => {
  vi.stubEnv("VOICE_ENABLED", "false");
  const { startVoiceSweeper } = await import("./voiceSweeper.js");
  await startVoiceSweeper().stop();
  expect(sweepVoiceSessions).not.toHaveBeenCalled();
});

it("sweeps once a minute, carries on after a failure and stops cleanly", async () => {
  vi.useFakeTimers();
  vi.stubEnv("VOICE_ENABLED", "true");
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  sweepVoiceSessions.mockRejectedValueOnce(new Error("database unavailable"));
  const { startVoiceSweeper } = await import("./voiceSweeper.js");
  const sweeper = startVoiceSweeper();
  await vi.advanceTimersByTimeAsync(0);
  expect(sweepVoiceSessions).toHaveBeenCalledTimes(1);
  // The failure is logged by kind only.
  expect(errors).toHaveBeenCalledWith("[voice-sweeper] sweep failed", "Error");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sweepVoiceSessions).toHaveBeenCalledTimes(2);
  await sweeper.stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sweepVoiceSessions).toHaveBeenCalledTimes(2);
});
