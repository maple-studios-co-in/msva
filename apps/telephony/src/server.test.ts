import net, { type AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";

// The origin the console and demo pages are served from in these tests.
const CONSOLE = "https://console.example.test";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("TELEPHONY_PORT", "0");
  vi.stubEnv("AGENT_BASE_URL", "http://api.test");
  vi.stubEnv("BROWSER_ORIGINS", CONSOLE);
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

/** Whether the upgrade was accepted, the status that refused it, or "closed" when the socket was just closed. */
function upgrade(url: string, headers: Record<string, string> = { origin: CONSOLE }): Promise<"open" | "closed" | number> {
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
    ws.once("close", () => resolve("closed"));
  });
}

it("opens a browser call only for an agent's console session", async () => {
  const checked = fakeApi((cookie) => cookie === "msva_session=agent"
    ? Response.json({ user: { role: "AGENT" } })
    : cookie === "msva_session=viewer"
      ? Response.json({ user: { role: "VIEWER" } })
      : Response.json({ error: "Sign in required" }, { status: 401 }));
  const service = await telephony();
  const call = `${service.url}/browser?call=live-demo`;
  try {
    expect(await upgrade(call)).toBe(401);
    expect(await upgrade(call, { origin: CONSOLE, cookie: "msva_session=stale" })).toBe(401);
    expect(await upgrade(call, { origin: CONSOLE, cookie: "msva_session=viewer" })).toBe(403);
    expect(await upgrade(call, { origin: CONSOLE, cookie: "msva_session=agent" })).toBe("open");
    // Without a cookie the API is not asked at all.
    expect(checked).toEqual(["msva_session=stale", "msva_session=viewer", "msva_session=agent"]);
  } finally {
    await service.close();
  }
});

it("refuses a browser call from any other origin, or none, before asking the API", async () => {
  const checked = fakeApi(() => Response.json({ user: { role: "ADMIN" } }));
  const service = await telephony();
  const call = `${service.url}/browser?call=live-demo`;
  try {
    expect(await upgrade(call, { cookie: "msva_session=admin" })).toBe(403);
    for (const origin of ["https://evil.example.test", "https://console.example.test.evil.test", "null"]) {
      expect(await upgrade(call, { origin, cookie: "msva_session=admin" })).toBe(403);
    }
    expect(checked).toEqual([]);
    // Only the exact path is a browser call.
    expect(await upgrade(`${service.url}/browserx?call=live-demo`, { origin: CONSOLE, cookie: "msva_session=admin" })).toBe("closed");
    expect(await upgrade(`${service.url}/browser/extra`, { origin: CONSOLE, cookie: "msva_session=admin" })).toBe("closed");
  } finally {
    await service.close();
  }
});

it("refuses a browser call when the sign-in cannot be checked", async () => {
  let answer: () => Promise<Response> = async () => { throw new TypeError("fetch failed"); };
  fakeApi(() => answer());
  const service = await telephony();
  try {
    expect(await upgrade(`${service.url}/browser`, { origin: CONSOLE, cookie: "msva_session=valid" })).toBe(503);
    answer = async () => Response.json({ error: "Internal server error" }, { status: 500 });
    expect(await upgrade(`${service.url}/browser`, { origin: CONSOLE, cookie: "msva_session=valid" })).toBe(503);
  } finally {
    await service.close();
  }
});

it("leaves the carrier's media stream to the carrier", async () => {
  const checked = fakeApi(() => Response.json({ error: "Sign in required" }, { status: 401 }));
  const service = await telephony();
  try {
    expect(await upgrade(`${service.url}/voice?call=sim-1`, {})).toBe("open");
    expect(checked).toEqual([]);
  } finally {
    await service.close();
  }
});


/** Sends a raw upgrade request and resolves with the status line of the answer, or "" when the socket is just closed. */
function rawUpgrade(url: string, target: string, host: string): Promise<string> {
  const { port } = new URL(url);
  return new Promise((resolve) => {
    let received = "";
    const socket = net.connect(Number(port), "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (received.includes("\r\n\r\n")) socket.destroy();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(received.split("\r\n")[0] ?? ""));
  });
}

it("survives upgrade requests whose target or host does not parse", async () => {
  fakeApi(() => Response.json({ error: "Sign in required" }, { status: 401 }));
  const service = await telephony();
  try {
    for (const target of ["//[/browser", "//[/voice", "//user@[/browser?call=x", "http://[/browser"]) {
      expect(await rawUpgrade(service.url, target, "127.0.0.1")).toBe("");
    }
    // A carrier stream with a host that is not a valid URL host still gets a socket, and nothing breaks.
    expect(await rawUpgrade(service.url, "/voice?call=sim-1", "a b")).toMatch(/^HTTP\/1\.1 101 /);
    expect(await upgrade(`${service.url}/voice?call=sim-2`, {})).toBe("open");
  } finally {
    await service.close();
  }
});


it("routes each upgrade on the exact path it names", async () => {
  const checked = fakeApi(() => Response.json({ user: { role: "ADMIN" } }));
  const service = await telephony();
  try {
    // No prefix, alias or dot segment reaches a call: in particular a carrier-looking
    // path can never open a browser call without its checks.
    for (const target of ["/voice/../browser/x", "/voice/", "/voicex", "/browser/", "/browser/../browser/x"]) {
      expect(await rawUpgrade(service.url, `${target}?call=x`, "127.0.0.1")).toBe("");
    }
    // One that names exactly /browser is a browser call, checked like any other.
    for (const target of ["/voice/../browser", "/voice/%2e%2e/browser"]) {
      expect(await rawUpgrade(service.url, `${target}?call=x`, "127.0.0.1")).toBe("HTTP/1.1 403 Forbidden");
    }
    expect(checked).toEqual([]);
  } finally {
    await service.close();
  }
});
