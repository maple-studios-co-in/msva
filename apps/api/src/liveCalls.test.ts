import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ $transaction: vi.fn(), $queryRaw: vi.fn() }));
vi.mock("@msva/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@msva/db")>(), prisma: db
}));
import { createLiveCallsHandler } from "./liveCalls.js";

const now = new Date("2026-09-17T00:10:00.000Z");
const summary = { totalCalls: 63, activeCalls: 2, completedCalls: 59, failedCalls: 2, tickets: 9, fallbackTurns: 3, recognitionRetries: 4 };
const row = {
  id: "provider-secret-session-id", provider: "EXOTEL", fromNumber: "+91 98765 43210",
  startedAt: new Date("2026-09-16T20:10:00.000Z"), endedAt: null,
  status: "IN_PROGRESS", durationMs: null, turns: 2, tickets: 1, fallbackTurns: 0,
  recognitionRetries: 1, isTest: false,
  // Additional columns from future query changes must never leak publicly.
  providerSid: "sensitive-sid", callerName: "Private name", collected: { address: "Private address" },
  metadata: { streamSid: "private-stream" }, callerText: "Private transcript", costPaise: 500
};
let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express();
  app.get("/api/live-calls", createLiveCallsHandler(() => now));
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
  db.$transaction.mockImplementation((callback: (tx: typeof db) => Promise<unknown>) => callback(db));
  db.$queryRaw.mockResolvedValueOnce([summary]).mockResolvedValueOnce([row]);
});

const get = (query = "") => fetch(`${origin}/api/live-calls${query}`);
const queries = () => db.$queryRaw.mock.calls.map(([sql]) => ({ text: sql.text as string, values: sql.values as unknown[] }));

describe("recorded live call feed", () => {
  it("returns only permitted facts with a masked number and opaque id", async () => {
    db.$queryRaw.mockReset().mockResolvedValueOnce([{ ...summary, privateNotes: "Private notes" }]).mockResolvedValueOnce([row]);
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      source: "recorded_calls", updatedAt: now.toISOString(), from: "2026-09-16T18:30:00.000Z",
      channel: "all", summary, total: 63, page: 1, pageSize: 25,
      items: [{
        id: expect.stringMatching(/^call_[a-f0-9]{24}$/), channel: "phone", caller: "•••• 3210",
        startedAt: row.startedAt.toISOString(), endedAt: null, status: "IN_PROGRESS", durationMs: null,
        turns: 2, tickets: 1, fallbackTurns: 0, recognitionRetries: 1, isTest: false
      }]
    });
    expect(JSON.stringify(body)).not.toMatch(/provider-secret|98765|Private|sensitive|private-stream|costPaise/);
  });

  it("preserves measured duration and terminal status instead of inferring business resolution", async () => {
    const endedAt = new Date("2026-09-16T20:11:05.000Z");
    db.$queryRaw.mockReset().mockResolvedValueOnce([summary]).mockResolvedValueOnce([
      { ...row, endedAt, durationMs: 65000, status: "COMPLETED", outcome: "RESOLVED_BY_VA" }
    ]);
    const body = await (await get()).json();
    expect(body.items[0]).toMatchObject({ endedAt: endedAt.toISOString(), durationMs: 65000, status: "COMPLETED" });
    expect(body.items[0]).not.toHaveProperty("outcome");
  });

  it("uses one consistent snapshot and aggregates the full filter, not the displayed page", async () => {
    const response = await get("?page=3&pageSize=10&channel=phone&from=2026-09-16T12:00:00%2B05:30");
    const body = await response.json();
    expect(body.summary.totalCalls).toBe(63);
    expect(body.items).toHaveLength(1);
    expect(body).toMatchObject({ from: "2026-09-16T06:30:00.000Z", channel: "phone", page: 3, pageSize: 10, total: 63 });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
    const [aggregate, page] = queries();
    expect(aggregate.text).not.toMatch(/LIMIT|OFFSET/);
    expect(page.text).toMatch(/ORDER BY c\."startedAt" DESC, c\."id" DESC/);
    expect(page.values.slice(-2)).toEqual([10, 20]);
    for (const query of [aggregate, page]) {
      expect(query.text).toContain('c."provider" IN');
      expect(query.values).toEqual(expect.arrayContaining(["EXOTEL", "TWILIO", new Date("2026-09-16T06:30:00.000Z")]));
      expect(query.text).toContain('c."startedAt" >=');
      expect(query.text).toContain('c."startedAt" <=');
      expect(query.text).toContain("COALESCE");
      expect(query.values).toEqual(expect.arrayContaining(["qa-%", "seed", "synthetic"]));
      expect(query.text).not.toContain('"isTest" = false');
    }
  });

  it("includes real browser test sessions without claiming the preset caller number is real", async () => {
    db.$queryRaw.mockReset().mockResolvedValueOnce([summary]).mockResolvedValueOnce([{ ...row, provider: "BROWSER", isTest: true }]);
    const body = await (await get("?channel=browser")).json();
    expect(body.items[0]).toMatchObject({ channel: "browser", caller: "Not provided", isTest: true });
    for (const query of queries()) expect(query.values).toContain("BROWSER");
  });

  it.each(["", "1234", "+91 0000000000", "0000000000", "browser-12345678", "anonymous"])("withholds missing or placeholder number %s", async (fromNumber) => {
    db.$queryRaw.mockReset().mockResolvedValueOnce([summary]).mockResolvedValueOnce([{ ...row, fromNumber }]);
    expect((await (await get()).json()).items[0].caller).toBe("Not provided");
  });

  it("returns an honest empty database result with no sample calls", async () => {
    const empty = Object.fromEntries(Object.keys(summary).map(key => [key, 0]));
    db.$queryRaw.mockReset().mockResolvedValueOnce([empty]).mockResolvedValueOnce([]);
    expect(await (await get()).json()).toMatchObject({ summary: empty, items: [], total: 0 });
  });

  it.each([
    "?from=not-a-date", "?from=2026-09-16", "?from=2026-02-30T00:00:00Z", "?from=2026-09-18T00:00:00Z",
    "?from=2026-09-16T00:00:00", "?channel=bad", "?channel=phone&channel=browser",
    "?page=0", "?page=1.5", "?page=10001", "?pageSize=0", "?pageSize=51", "?pageSize=NaN"
  ])("rejects invalid filters %s before querying the database", async (query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("responds with 503, never fake zeros or private database errors, when persistence is unavailable", async () => {
    db.$transaction.mockRejectedValueOnce(new Error("postgres://secret:password@private-host"));
    const response = await get();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "Recorded calls are temporarily unavailable. Please try again." });
  });

  it("does not publish a partial aggregate when reading its call page fails", async () => {
    db.$queryRaw.mockReset().mockResolvedValueOnce([summary]).mockRejectedValueOnce(new Error("connection lost"));
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("summary");
  });
});
