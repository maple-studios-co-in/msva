import http from "node:http";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { apiErrorHandler } from "./httpErrors.js";

afterEach(() => vi.restoreAllMocks());

async function post(body: string) {
  const app = express();
  app.use(express.json({ limit: "64b" }));
  app.post("/echo", (request, response) => { response.json(request.body); });
  app.use(apiErrorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it("answers malformed and oversized JSON without logging the body", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await post('{"text": "mera doodh kharab tha"')).toEqual({ status: 400, body: { error: "INVALID_JSON" } });
  expect(await post(JSON.stringify({ text: "x".repeat(200) }))).toEqual({ status: 413, body: { error: "PAYLOAD_TOO_LARGE" } });
  expect(error).not.toHaveBeenCalled();
  expect(await post('{"ok":true}')).toEqual({ status: 200, body: { ok: true } });
});
