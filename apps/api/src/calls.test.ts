import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({
  call: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  agent: { findFirst: vi.fn() },
  turn: { upsert: vi.fn() },
  utterance: { deleteMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn()
}));
vi.mock("@msva/db", () => ({ prisma: db }));
import { recordCallStart, recordCallEnd, recordTurn } from "./calls.js";
beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((writes: unknown[]) => Promise.all(writes));
  db.call.update.mockResolvedValue({ id: "call-1" });
});
function savedCall(overrides: Record<string, unknown> = {}) {
  return { id: "call-1", startedAt: new Date(Date.now() - 5000), endedAt: null, outcome: "IN_PROGRESS", _count: { turns: 3, tickets: 0 }, ...overrides };
}
describe("honest ended-call outcomes", () => {
  it.each([1, 2, 4])("does not infer success from %i logged turns, which may all be errors", async turns => {
    db.call.findUnique.mockResolvedValue(savedCall({ _count: { turns, tickets: 0 } }));
    await recordCallEnd("call-1", {});
    expect(db.call.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED", outcome: "IN_PROGRESS" }) }));
  });
  it.each(["RESOLVED_BY_VA", "HUMAN_TRANSFER"])("preserves verified %s when the end payload is stale", async outcome => {
    db.call.findUnique.mockResolvedValue(savedCall({ outcome }));
    await recordCallEnd("call-1", { outcome: "in_progress" });
    expect(db.call.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcome }) }));
  });
  it("keeps a saved ticket as confirmed evidence", async () => {
    db.call.findUnique.mockResolvedValue(savedCall({ _count: { turns: 1, tickets: 1 } }));
    await recordCallEnd("call-1", { outcome: "in_progress" });
    expect(db.call.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcome: "TICKET_CREATED" }) }));
  });
  it("marks an empty call abandoned without claiming resolution", async () => {
    db.call.findUnique.mockResolvedValue(savedCall({ _count: { turns: 0, tickets: 0 } }));
    await recordCallEnd("call-1", {});
    expect(db.call.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcome: "ABANDONED" }) }));
  });
});

describe("turns arriving after disconnect", () => {
  it.each([
    { source: "fallback", callerText: "Hello", replyText: "Abhi dikkat aa rahi hai", outcome: "in_progress" },
    { source: "asr_error", callerText: null, replyText: "Dobara kahiye" }
  ])("reconciles a late $source turn without extending the call", async turn => {
    const row: Record<string, any> = savedCall({ _count: { turns: 0, tickets: 0 } });
    db.call.findUnique.mockImplementation(async () => row);
    db.call.update.mockImplementation(async ({ data }) => Object.assign(row, data));
    await recordCallEnd("call-1", {});
    expect(row.outcome).toBe("ABANDONED");
    const disconnectedAt = row.endedAt;
    const duration = row.durationMs;
    await recordTurn("call-1", { index: 1, ...turn });
    expect(row.outcome).toBe("IN_PROGRESS");
    expect(row.status).toBe("COMPLETED");
    expect(row.endedAt).toBe(disconnectedAt);
    expect(row.durationMs).toBe(duration);
    expect(db.turn.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ callId: "call-1", index: 1, source: turn.source }) }));
  });
  it("recognizes a saved ticket when the final turn arrives after the end event", async () => {
    const row: Record<string, any> = savedCall({ _count: { turns: 0, tickets: 0 } });
    db.call.findUnique.mockImplementation(async () => row);
    db.call.update.mockImplementation(async ({ data }) => Object.assign(row, data));
    await recordCallEnd("call-1", {});
    const disconnectedAt = row.endedAt;
    row._count.tickets = 1;
    await recordTurn("call-1", { index: 1, callerText: "Ticket bana do", outcome: "in_progress" });
    expect(row.outcome).toBe("TICKET_CREATED");
    expect(row.endedAt).toBe(disconnectedAt);
  });
  it("does not downgrade a verified outcome when a late fallback turn arrives", async () => {
    const row: Record<string, any> = savedCall({ outcome: "TICKET_CREATED" });
    db.call.findUnique.mockImplementation(async () => row);
    db.call.update.mockImplementation(async ({ data }) => Object.assign(row, data));
    await recordCallEnd("call-1", {});
    await recordTurn("call-1", { index: 4, callerText: "Thanks", outcome: "in_progress" });
    expect(row.outcome).toBe("TICKET_CREATED");
  });
});

describe("captured lifecycle times", () => {
  it("uses captured start time only on creation so retry does not move the call start", async () => {
    db.agent.findFirst.mockResolvedValue(null);
    db.call.upsert.mockResolvedValue({ id: "call-1" });
    await recordCallStart({ id: "call-1", provider: "browser", fromNumber: "browser", startedAt: "2026-09-16T07:00:00.000Z" });
    expect(db.call.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ startedAt: new Date("2026-09-16T07:00:00.000Z") }) }));
    expect(db.call.upsert.mock.calls[0]![0].update).not.toHaveProperty("startedAt");
  });
  it("uses actual disconnect time even when persistence is delayed", async () => {
    db.call.findUnique.mockResolvedValue(savedCall({ startedAt: new Date("2026-09-16T07:00:00.000Z") }));
    await recordCallEnd("call-1", { endedAt: "2026-09-16T07:00:05.000Z" });
    expect(db.call.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ endedAt: new Date("2026-09-16T07:00:05.000Z"), durationMs: 5000 }) }));
  });
  it("clamps clock skew so disconnect never predates the saved start", async () => {
    db.call.findUnique.mockResolvedValue(savedCall({ startedAt: new Date("2026-09-16T07:00:00.000Z") }));
    await recordCallEnd("call-1", { endedAt: "2026-09-16T06:59:59.000Z" });
    expect(db.call.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ endedAt: new Date("2026-09-16T07:00:00.000Z"), durationMs: 0 }) }));
  });
});
