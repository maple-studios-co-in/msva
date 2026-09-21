import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("TELEPHONY_PORT", "0");
  vi.stubEnv("AGENT_BASE_URL", "http://api.test");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Fakes the API: its answer to a session check by cookie; anything else the pipelines post is acknowledged. */
function fakeApi(session: (cookie: string | null) => Response | Promise<Response>) {
  const checked: (string | null)[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname !== "/api/admin/me") return Response.json({ ok: true });
    const cookie = new Headers(init?.headers).get("cookie");
    checked.push(cookie);
    return session(cookie);
  }));
  return checked;
}

async function telephony() {
  const { server } = await import("./server.js");
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Whether the upgrade was accepted, or the status that refused it. */
function upgrade(url: string, headers: Record<string, string> = {}): Promise<"open" | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("error", () => undefined);
    ws.once("open", () => {
      ws.close();
      resolve("open");
    });
    ws.once("unexpected-response", (request, response) => {
      resolve(response.statusCode ?? 0);
      request.destroy();
    });
  });
}

it("opens a browser call only for a signed-in console session", async () => {
  const checked = fakeApi((cookie) => cookie === "msva_session=valid"
    ? Response.json({ user: { role: "VIEWER" } })
    : Response.json({ error: "Sign in required" }, { status: 401 }));
  const service = await telephony();
  try {
    expect(await upgrade(`${service.url}/browser?call=live-demo`)).toBe(401);
    expect(await upgrade(`${service.url}/browser?call=live-demo`, { cookie: "msva_session=stale" })).toBe(401);
    expect(await upgrade(`${service.url}/browser?call=live-demo`, { cookie: "msva_session=valid" })).toBe("open");
    // Without a cookie the API is not asked at all.
    expect(checked).toEqual(["msva_session=stale", "msva_session=valid"]);
  } finally {
    await service.close();
  }
});

it("refuses a browser call when the sign-in cannot be checked", async () => {
  let answer: () => Promise<Response> = async () => { throw new TypeError("fetch failed"); };
  fakeApi(() => answer());
  const service = await telephony();
  try {
    expect(await upgrade(`${service.url}/browser`, { cookie: "msva_session=valid" })).toBe(503);
    answer = async () => Response.json({ error: "Internal server error" }, { status: 500 });
    expect(await upgrade(`${service.url}/browser`, { cookie: "msva_session=valid" })).toBe(503);
  } finally {
    await service.close();
  }
});

it("leaves the carrier's media stream to the carrier", async () => {
  const checked = fakeApi(() => Response.json({ error: "Sign in required" }, { status: 401 }));
  const service = await telephony();
  try {
    expect(await upgrade(`${service.url}/voice?call=sim-1`)).toBe("open");
    expect(checked).toEqual([]);
  } finally {
    await service.close();
  }
});
