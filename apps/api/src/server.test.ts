import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./assessmentWorker.js");
  vi.doUnmock("./voiceSweeper.js");
  vi.unstubAllEnvs();
});

// pm2's fork mode loads the entry point from its own container script, so the entry
// point must start whichever module loads it, as this test's does.
it("starts the API and its background workers when another module loads it", async () => {
  vi.stubEnv("PORT", "0");
  vi.stubEnv("BROWSER_ORIGINS", "https://console.example.test");
  const assessmentWorker = { stop: vi.fn(async () => {}) };
  const voiceSweeper = { stop: vi.fn(async () => {}) };
  const startAssessmentWorker = vi.fn(() => assessmentWorker);
  const startVoiceSweeper = vi.fn(() => voiceSweeper);
  vi.doMock("./assessmentWorker.js", () => ({ startAssessmentWorker }));
  vi.doMock("./voiceSweeper.js", () => ({ startVoiceSweeper }));
  const before = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };
  const { server } = await import("./server.js");
  const [stop] = process.listeners("SIGTERM").filter((listener) => !before.SIGTERM.includes(listener));
  try {
    if (!server.listening) await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    expect((await fetch(`http://127.0.0.1:${port}/api/demo-calls`)).status).toBe(200);
    expect(startAssessmentWorker).toHaveBeenCalledOnce();
    expect(startVoiceSweeper).toHaveBeenCalledOnce();
    // A stop stops both workers and then the server.
    server.closeAllConnections();
    stop("SIGTERM");
    await vi.waitFor(() => expect(server.listening).toBe(false));
    expect(assessmentWorker.stop).toHaveBeenCalledOnce();
    expect(voiceSweeper.stop).toHaveBeenCalledOnce();
  } finally {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      for (const listener of process.listeners(signal)) if (!before[signal].includes(listener)) process.removeListener(signal, listener);
    }
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
