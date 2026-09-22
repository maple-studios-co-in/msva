import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("sends telephony turns only to the authenticated internal SSE route", async () => {
  vi.stubEnv("INTERNAL_API_TOKEN", "test-internal-token");
  const fetchMock = vi.fn().mockResolvedValue(new Response('data: {"type":"final","state":{},"source":"fallback"}\n\n'));
  vi.stubGlobal("fetch", fetchMock);
  const { streamAgent } = await import("./agentClient.js");

  for await (const _event of streamAgent("call-123456", "hello", undefined, "call-123456", "EXOTEL")) {
    // Exhaust the stream.
  }

  expect(fetchMock).toHaveBeenCalledWith(
    "http://127.0.0.1:4100/api/internal/agent/chat/stream",
    expect.objectContaining({
      headers: expect.objectContaining({ "x-internal-token": "test-internal-token" }),
      body: expect.stringContaining('"transport":"EXOTEL"')
    })
  );
});
