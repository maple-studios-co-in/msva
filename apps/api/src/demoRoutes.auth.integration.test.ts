import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { PrismaClient } from "@msva/db";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const databaseUrl = process.env.MSVA_AUTH_TEST_DATABASE_URL;
// These tests delete users and sessions: only ever against the disposable database,
// and only when the app's own connection points at the same one.
if (!databaseUrl || databaseUrl !== process.env.DATABASE_URL || !new URL(databaseUrl).pathname.endsWith("/msva_auth_test")) {
  throw new Error("DATABASE_URL and MSVA_AUTH_TEST_DATABASE_URL must match the disposable msva_auth_test database");
}
const db = new PrismaClient({ datasourceUrl: databaseUrl });

const provider = vi.hoisted(() => ({ handleChat: vi.fn(), previewVoice: vi.fn(), setLlmEnabled: vi.fn() }));
// The origin the console and demo pages are served from in these tests.
const CONSOLE = "https://console.example.test";

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("BROWSER_ORIGINS", CONSOLE);
  provider.handleChat.mockReset().mockResolvedValue({ reply: "Namaste", state: {} });
  provider.previewVoice.mockReset().mockResolvedValue({ ok: true, data: { voice: "anushka", audio: "" } });
  provider.setLlmEnabled.mockReset();
  vi.doMock("./voiceAgent.js", () => ({
    streamChat: vi.fn(),
    getActiveModel: () => "test",
    getLlmEnabled: () => true,
    handleChat: provider.handleChat,
    initialState: vi.fn(),
    setLlmEnabled: provider.setLlmEnabled
  }));
  vi.doMock("./sarvamPreview.js", () => ({ BULBUL_V3_VOICES: {}, previewVoice: provider.previewVoice }));
  await db.session.deleteMany();
  await db.user.deleteMany();
});
afterEach(() => {
  vi.doUnmock("./voiceAgent.js");
  vi.doUnmock("./sarvamPreview.js");
  vi.unstubAllEnvs();
});
afterAll(async () => db.$disconnect());

/** A console session cookie for a new user with `role`, or with an expired or disabled login. */
async function sessionCookie(role: "VIEWER" | "AGENT" | "SUPERVISOR" | "ADMIN", options: { expired?: boolean; disabled?: boolean } = {}) {
  const user = await db.user.create({ data: { email: `${randomBytes(6).toString("hex")}@example.test`, name: "Staff", role, active: !options.disabled } });
  const token = randomBytes(32).toString("hex");
  await db.session.create({ data: {
    userId: user.id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + (options.expired ? -60_000 : 3_600_000))
  } });
  return `msva_session=${token}`;
}

async function demoApp() {
  const { createApp } = await import("./server.js");
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("node:net").AddressInfo;
  const post = (path: string, body: object, cookie?: string, origin: string | null = CONSOLE) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
    body: JSON.stringify(body)
  });
  return { post, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

it("lets a signed-in agent chat and preview voices, and no viewer", async () => {
  const app = await demoApp();
  try {
    const viewer = await sessionCookie("VIEWER");
    expect((await app.post("/api/voice-agent/chat", { callId: "call-123456", message: "hello" }, viewer)).status).toBe(403);
    expect((await app.post("/api/voice-agent/tts-preview", { voice: "anushka", text: "Namaste" }, viewer)).status).toBe(403);
    expect(provider.handleChat).not.toHaveBeenCalled();
    const agent = await sessionCookie("AGENT");
    expect((await app.post("/api/voice-agent/chat", { callId: "call-123456", message: "hello" }, agent)).status).toBe(200);
    expect((await app.post("/api/voice-agent/tts-preview", { voice: "anushka", text: "Namaste" }, agent)).status).toBe(200);
    expect(provider.handleChat).toHaveBeenCalledOnce();
    expect(provider.previewVoice).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

it("refuses a signed-in request from any other origin, or none", async () => {
  const app = await demoApp();
  try {
    const admin = await sessionCookie("ADMIN");
    for (const origin of [null, "https://evil.example.test", "https://console.example.test.evil.test"]) {
      expect((await app.post("/api/voice-agent/chat", { callId: "call-123456", message: "hello" }, admin, origin)).status).toBe(403);
      expect((await app.post("/api/voice-agent/tts-preview", { voice: "anushka", text: "Namaste" }, admin, origin)).status).toBe(403);
      expect((await app.post("/api/voice-agent/llm-mode", { enabled: false }, admin, origin)).status).toBe(403);
    }
    expect(provider.handleChat).not.toHaveBeenCalled();
    expect(provider.previewVoice).not.toHaveBeenCalled();
    expect(provider.setLlmEnabled).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("refuses an expired session and a disabled user", async () => {
  const app = await demoApp();
  try {
    for (const cookie of [await sessionCookie("ADMIN", { expired: true }), await sessionCookie("ADMIN", { disabled: true })]) {
      expect((await app.post("/api/voice-agent/chat", { callId: "call-123456", message: "hello" }, cookie)).status).toBe(401);
      expect((await app.post("/api/voice-agent/llm-mode", { enabled: false }, cookie)).status).toBe(401);
    }
    expect(provider.handleChat).not.toHaveBeenCalled();
    expect(provider.setLlmEnabled).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("lets only a supervisor or an admin switch the model for every call", async () => {
  const app = await demoApp();
  try {
    for (const role of ["VIEWER", "AGENT"] as const) {
      expect((await app.post("/api/voice-agent/llm-mode", { enabled: false }, await sessionCookie(role))).status).toBe(403);
    }
    expect(provider.setLlmEnabled).not.toHaveBeenCalled();
    for (const role of ["SUPERVISOR", "ADMIN"] as const) {
      expect((await app.post("/api/voice-agent/llm-mode", { enabled: false }, await sessionCookie(role))).status).toBe(200);
    }
    expect(provider.setLlmEnabled).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
  }
});
