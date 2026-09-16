import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const start = (id: string) => ({ id, provider: "browser" as const, fromNumber: "browser", isTest: true });
beforeEach(() => { vi.resetModules(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("call log ordering and bounded failure", () => {
  it("persists start then queued turns then end while another call can proceed independently", async () => {
    const requests: { path: string; body: any; finish: () => void }[] = [];
    vi.stubGlobal("fetch", vi.fn((url, init) => new Promise<Response>(resolve => {
      requests.push({ path: new URL(url).pathname, body: JSON.parse(init.body), finish: () => resolve(Response.json({ ok: true })) });
    })));
    const { callLog } = await import("./callLog.js");
    const a = [callLog.start(start("a")), callLog.turn("a", { index: 1 }), callLog.turn("a", { index: 2 }), callLog.end("a")];
    const b = callLog.start(start("b"));
    await settle();
    expect(requests.map(r => r.body.id)).toEqual(["a", "b"]);
    requests[1]!.finish(); await b;
    requests[0]!.finish(); await settle();
    expect(requests[2]).toMatchObject({ path: "/api/internal/calls/a/turns", body: { index: 1 } });
    requests[2]!.finish(); await settle();
    expect(requests[3]).toMatchObject({ path: "/api/internal/calls/a/turns", body: { index: 2 } });
    requests[3]!.finish(); await settle();
    expect(requests[4]?.path).toBe("/api/internal/calls/a/end");
    requests[4]!.finish(); await Promise.all(a);
  });
  it("retries a transient failure before allowing the end report through", async () => {
    const paths: string[] = [];
    let failed = false;
    vi.stubGlobal("fetch", vi.fn(async url => {
      paths.push(new URL(url).pathname);
      if (!failed) { failed = true; return new Response("unavailable", { status: 503 }); }
      return Response.json({ ok: true });
    }));
    const { callLog } = await import("./callLog.js");
    await Promise.all([callLog.start(start("a")), callLog.end("a")]);
    expect(paths).toEqual(["/api/internal/calls/start", "/api/internal/calls/start", "/api/internal/calls/a/end"]);
  });
  it("releases a stalled request after bounded retries even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    const paths: string[] = [];
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((url, init) => {
      const path = new URL(url).pathname; paths.push(path); signals.push(init.signal);
      return path.endsWith("/start") ? new Promise<Response>(() => {}) : Promise.resolve(Response.json({ ok: true }));
    }));
    const { callLog } = await import("./callLog.js");
    let completed = false;
    const pending = Promise.all([callLog.start(start("a")), callLog.end("a")]).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(completed).toBe(true);
    expect(paths.filter(p => p.endsWith("/start")).length).toBeLessThanOrEqual(3);
    expect(paths.at(-1)).toBe("/api/internal/calls/a/end");
    expect(signals[0]?.aborted).toBe(true);
    await pending;
  });
  it("does not retry non-transient errors or retain a rejected call queue", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async url => { paths.push(new URL(url).pathname); return new Response("invalid", { status: 400 }); }));
    const { callLog } = await import("./callLog.js");
    await callLog.start(start("same"));
    await callLog.end("same");
    await callLog.start(start("same"));
    expect(paths).toEqual(["/api/internal/calls/start", "/api/internal/calls/same/end", "/api/internal/calls/start"]);
  });
});

it("captures event times before retries and queue waits", async () => {
  vi.useFakeTimers();
  const requests: { path: string; body: any }[] = [];
  let release!: () => void;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: JSON.parse(init.body) });
    if (requests.length === 1) return new Response("retry", { status: 503 });
    if (requests.length === 2) return new Promise<Response>(resolve => { release = () => resolve(Response.json({ ok: true })); });
    return Response.json({ ok: true });
  }));
  const { callLog } = await import("./callLog.js");
  vi.setSystemTime(new Date("2026-09-16T07:00:00.000Z"));
  const started = callLog.start(start("times"));
  await settle();
  vi.setSystemTime(new Date("2026-09-16T07:00:05.000Z"));
  const ended = callLog.end("times");
  vi.setSystemTime(new Date("2026-09-16T07:01:00.000Z"));
  release();
  await Promise.all([started, ended]);
  expect(requests[0]?.body.startedAt).toBe("2026-09-16T07:00:00.000Z");
  expect(requests[1]?.body.startedAt).toBe("2026-09-16T07:00:00.000Z");
  expect(requests[2]?.body.endedAt).toBe("2026-09-16T07:00:05.000Z");
});
