import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  getCallAssessment: vi.fn(),
  requestCallAssessment: vi.fn(),
  isAllowedJevOrigin: vi.fn()
}));

vi.mock("./callAssessment.js", () => service);
vi.mock("@msva/db", () => ({ prisma: {} }));
vi.mock("./auth.js", () => {
  const rank = { VIEWER: 0, AGENT: 1, SUPERVISOR: 2, ADMIN: 3 };
  return {
    authenticate: (request: express.Request, _response: express.Response, next: express.NextFunction) => {
      const role = request.header("x-test-role") as keyof typeof rank | undefined;
      if (role) request.user = { id: "test-user", email: "test@example.invalid", name: "Test user", role };
      next();
    },
    requireRole: (minimum: keyof typeof rank) => (request: express.Request, response: express.Response, next: express.NextFunction) => {
      if (!request.user) return void response.status(401).json({ error: "Sign in required" });
      if (rank[request.user.role] < rank[minimum]) return void response.status(403).json({ error: "Forbidden" });
      next();
    },
    audit: vi.fn(),
    requestLoginCode: vi.fn(),
    revokeSession: vi.fn(),
    sessionCookie: vi.fn(),
    tokenFromRequest: vi.fn(),
    verifyLoginCode: vi.fn()
  };
});

import { adminRouter } from "./routes/admin.js";

let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

beforeEach(() => {
  vi.resetAllMocks();
  service.isAllowedJevOrigin.mockReturnValue(true);
  service.getCallAssessment.mockResolvedValue({
    found: true,
    response: { capability: { enabled: false, available: false, reason: "DISABLED" }, eligibility: { eligible: true, reason: null }, assessment: null, current: false }
  });
  service.requestCallAssessment.mockResolvedValue({ found: true, unavailable: true, pending: false });
});

const request = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, init);

describe("call assessment admin route guards", () => {
  it("requires a viewer session for GET and performs no provider request", async () => {
    expect((await request("/api/admin/calls/call-1/assessment")).status).toBe(401);
    const response = await request("/api/admin/calls/call-1/assessment", { headers: { "x-test-role": "VIEWER" } });
    expect(response.status).toBe(200);
    expect(service.getCallAssessment).toHaveBeenCalledWith("call-1");
    expect(service.requestCallAssessment).not.toHaveBeenCalled();
  });

  it("requires supervisor, exact origin, JSON, and an empty body for POST", async () => {
    const path = "/api/admin/calls/call-1/assessment";
    expect((await request(path, { method: "POST", headers: { "content-type": "application/json", "origin": "https://console.test", "x-test-role": "VIEWER" }, body: "{}" })).status).toBe(403);

    service.isAllowedJevOrigin.mockReturnValue(false);
    expect((await request(path, { method: "POST", headers: { "content-type": "application/json", "origin": "https://wrong.test", "x-test-role": "SUPERVISOR" }, body: "{}" })).status).toBe(403);
    expect(service.requestCallAssessment).not.toHaveBeenCalled();

    service.isAllowedJevOrigin.mockReturnValue(true);
    expect((await request(path, { method: "POST", headers: { "content-type": "application/json", "origin": "https://console.test", "x-test-role": "SUPERVISOR" }, body: '{"model":"untrusted"}' })).status).toBe(400);
    expect((await request(path, { method: "POST", headers: { "content-type": "text/plain", "origin": "https://console.test", "x-test-role": "SUPERVISOR" }, body: "{}" })).status).toBe(415);
    expect(service.requestCallAssessment).not.toHaveBeenCalled();
  });

  it("only calls the server-owned service after all POST guards pass", async () => {
    const response = await request("/api/admin/calls/call-1/assessment", {
      method: "POST",
      headers: { "content-type": "application/json", "origin": "https://console.test", "x-test-role": "SUPERVISOR" },
      body: "{}"
    });
    expect(response.status).toBe(503);
    expect(service.requestCallAssessment).toHaveBeenCalledWith("call-1", "test-user");
  });
});
