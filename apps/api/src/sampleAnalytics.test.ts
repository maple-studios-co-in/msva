import express from "express";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSampleAnalytics } from "./sampleAnalytics.js";

const header = "Src,associated_mobile,call_start_time_in,duration_in,duration_out,call_status_out,calllevel_department,if_voicemail,if_callrecording";
const validRow = "9999999999,9999999999,16/09/2026 10:00:00,60,50,ANSWERED,Support,0,0";
let directory: string;
let csvPath: string;
let server: Server | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "msva-sample-analytics-"));
  csvPath = join(directory, "optional.csv");
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await rm(directory, { recursive: true, force: true });
});
async function start() {
  const sample = createSampleAnalytics(csvPath);
  const app = express();
  app.use("/api/analytics", sample.router);
  app.get("/health", (_request, response) => response.json({ ok: true, records: sample.recordCount, sampleAnalytics: sample.status }));
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve());
  });
  const address = server!.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  return { sample, origin: `http://127.0.0.1:${address.port}` };
}

describe("optional sample analytics", () => {
  it("starts and reports health without opening a missing sample CSV", async () => {
    const { sample, origin } = await start();
    expect(sample.status).toBe("not_loaded");
    expect(sample.recordCount).toBeNull();
    expect(await (await fetch(`${origin}/health`)).json()).toEqual({ ok: true, records: null, sampleAnalytics: "not_loaded" });
  });

  it.each([undefined, '"unfinished CSV', "wrong,columns\nhello,world", header, `${header}\n${validRow.replace("16/09/2026", "31/02/2026")}`])(
    "returns explicit unavailability for missing or malformed optional data (%s)", async (contents) => {
      if (contents !== undefined) await writeFile(csvPath, contents);
      const { sample, origin } = await start();
      const response = await fetch(`${origin}/api/analytics`);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "Sample analytics are unavailable. Recorded live calls are unaffected." });
      expect(sample.status).toBe("unavailable");
      expect(sample.recordCount).toBeNull();
      expect((await fetch(`${origin}/health`)).status).toBe(200);
    }
  );

  it("loads sample data lazily, caches successful results and reloads explicitly", async () => {
    await writeFile(csvPath, `${header}\n${validRow}`);
    const { sample, origin } = await start();
    expect(sample.recordCount).toBeNull();
    expect((await (await fetch(`${origin}/api/analytics`)).json()).kpis.totalCalls).toBe(1);
    expect(sample.recordCount).toBe(1);
    expect(sample.status).toBe("ready");
    await writeFile(csvPath, `${header}\n${validRow}\n${validRow}`);
    expect((await (await fetch(`${origin}/api/analytics`)).json()).kpis.totalCalls).toBe(1);
    expect(await (await fetch(`${origin}/api/analytics/reload`, { method: "POST" })).json()).toEqual({ ok: true, records: 2 });
    expect((await (await fetch(`${origin}/api/analytics`)).json()).kpis.totalCalls).toBe(2);
  });

  it("invalidates stale cached success when reload fails, then recovers when data is repaired", async () => {
    await writeFile(csvPath, `${header}\n${validRow}`);
    const { sample, origin } = await start();
    expect((await fetch(`${origin}/api/analytics`)).status).toBe(200);
    await rm(csvPath);
    expect((await fetch(`${origin}/api/analytics/reload`, { method: "POST" })).status).toBe(503);
    expect(sample.recordCount).toBeNull();
    expect((await fetch(`${origin}/api/analytics`)).status).toBe(503);
    await writeFile(csvPath, `${header}\n${validRow}`);
    expect((await fetch(`${origin}/api/analytics`)).status).toBe(200);
    expect(sample.status).toBe("ready");
  });
});
