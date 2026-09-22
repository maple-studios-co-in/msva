import http from "node:http";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";

async function serve(app: express.Express) {
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
  vi.doUnmock("../voiceAgent.js");
  vi.unstubAllEnvs();
});

it("rejects unauthenticated internal SSE before the provider generator runs", async () => {
  vi.stubEnv("INTERNAL_API_TOKEN", "service-token");
  const streamChat = vi.fn(async function* () { yield { type: "token", text: "never" }; });
  vi.doMock("../voiceAgent.js", () => ({ streamChat }));
  const { internalAgentRouter } = await import("./internalAgent.js");
  const app = express();
  app.use(express.json());
  app.use("/api/internal/agent", internalAgentRouter);
  const testServer = await serve(app);
  try {
    const response = await fetch(`${testServer.url}/api/internal/agent/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callId: "call-123456", message: "hello", transport: "EXOTEL", sessionId: "call-123456" })
    });
    expect(response.status).toBe(401);
    expect(streamChat).not.toHaveBeenCalled();
  } finally {
    await testServer.close();
  }
});

it("accepts a bounded authenticated Exotel envelope", async () => {
  vi.stubEnv("INTERNAL_API_TOKEN", "service-token");
  const streamChat = vi.fn(async function* () { yield { type: "final", state: {}, source: "fallback" }; });
  vi.doMock("../voiceAgent.js", () => ({ streamChat }));
  const { internalAgentRouter } = await import("./internalAgent.js");
  const app = express();
  app.use(express.json());
  app.use("/api/internal/agent", internalAgentRouter);
  const testServer = await serve(app);
  try {
    const response = await fetch(`${testServer.url}/api/internal/agent/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": "service-token" },
      body: JSON.stringify({ callId: "call-123456", message: "hello", transport: "EXOTEL", sessionId: "call-123456" })
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"type":"final"');
    expect(streamChat).toHaveBeenCalledWith("call-123456", "hello", undefined, "call-123456");
  } finally {
    await testServer.close();
  }
});
