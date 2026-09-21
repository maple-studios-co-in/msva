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
  vi.doUnmock("./sarvamPreview.js");
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

it("has no public agent stream route", async () => {
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
    const response = await fetch(`${testServer.url}/api/voice-agent/chat/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: "call-123456", message: "hello" })
    });
    expect(response.status).toBe(404);
    expect(streamChat).not.toHaveBeenCalled();
  } finally {
    await testServer.close();
  }
});

it("refuses the demo's provider routes without a console sign-in", async () => {
  const handleChat = vi.fn();
  const setLlmEnabled = vi.fn();
  const previewVoice = vi.fn();
  vi.doMock("./voiceAgent.js", () => ({
    streamChat: vi.fn(),
    getActiveModel: () => "test",
    getLlmEnabled: () => true,
    handleChat,
    initialState: vi.fn(),
    setLlmEnabled
  }));
  vi.doMock("./sarvamPreview.js", () => ({ BULBUL_V3_VOICES: {}, previewVoice }));
  const { createApp } = await import("./server.js");
  const testServer = await serve(createApp());
  const post = (path: string, body: object) => fetch(`${testServer.url}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    expect((await post("/api/voice-agent/chat", { callId: "call-123456", message: "hello" })).status).toBe(401);
    expect((await post("/api/voice-agent/tts-preview", { voice: "anushka", text: "Namaste" })).status).toBe(401);
    expect((await post("/api/voice-agent/llm-mode", { enabled: false })).status).toBe(401);
    expect(handleChat).not.toHaveBeenCalled();
    expect(previewVoice).not.toHaveBeenCalled();
    expect(setLlmEnabled).not.toHaveBeenCalled();
  } finally {
    await testServer.close();
  }
});

it("fails closed through the mounted login route when production SMTP is unavailable", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const { createApp } = await import("./server.js");
  const testServer = await serve(createApp());
  try {
    const response = await fetch(`${testServer.url}/api/admin/auth/request-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "known@example.test" })
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Sign-in is temporarily unavailable" });
  } finally {
    await testServer.close();
  }
});

it("refuses sign-in email addresses longer than 254 characters", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const { createApp } = await import("./server.js");
  const testServer = await serve(createApp());
  const post = (path: string, body: object) => fetch(`${testServer.url}/api/admin/auth/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const longest = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(62)}.test`;
  expect(longest).toHaveLength(254);
  try {
    // At the limit the address is accepted, and sign-in then fails closed without SMTP.
    expect((await post("request-code", { email: longest })).status).toBe(503);
    expect((await post("request-code", { email: `a${longest}` })).status).toBe(400);
    expect((await post("verify", { email: `a${longest}`, code: "123456" })).status).toBe(400);
  } finally {
    await testServer.close();
  }
});
