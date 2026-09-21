import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";

async function serve(app: import("express").Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./voiceAgent.js");
  vi.unstubAllEnvs();
});

it("mounts the strict internal agent route before the legacy internal router", async () => {
  vi.stubEnv("INTERNAL_API_TOKEN", "service-token");
  const streamChat = vi.fn(async function* () { yield { type: "final", state: {}, source: "fallback" }; });
  vi.doMock("./voiceAgent.js", () => ({
    streamChat,
    getActiveModel: () => "test",
    getLlmEnabled: () => false,
    handleChat: vi.fn(),
    initialState: vi.fn(),
    setLlmEnabled: vi.fn()
  }));
  const { createApp } = await import("./server.js");
  const testServer = await serve(createApp());
  try {
    const body = { callId: "call-123456", message: "hello", transport: "EXOTEL", sessionId: "call-123456" };
    const rejected = await fetch(`${testServer.url}/api/internal/agent/chat/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    expect(rejected.status).toBe(401);
    const accepted = await fetch(`${testServer.url}/api/internal/agent/chat/stream`, {
      method: "POST", headers: { "content-type": "application/json", "x-internal-token": "service-token" }, body: JSON.stringify(body)
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain('"type":"final"');
    expect(streamChat).toHaveBeenCalledOnce();
  } finally {
    await testServer.close();
  }
});
