import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DemoSchemas } from "./demo.js";

type CorpusItem = { schema: keyof typeof DemoSchemas; file?: string; payload?: unknown; name?: string };
type Corpus = { valid: CorpusItem[]; invalid: CorpusItem[] };

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/demo-journeys");

async function payloadFor(item: CorpusItem): Promise<unknown> {
  if (item.file) return JSON.parse(await readFile(join(fixtureDirectory, item.file), "utf8"));
  return item.payload;
}

describe("demo contract corpus", () => {
  it("accepts every shared valid fixture", async () => {
    const corpus = JSON.parse(await readFile(join(fixtureDirectory, "corpus.json"), "utf8")) as Corpus;
    for (const item of corpus.valid) {
      expect(DemoSchemas[item.schema].safeParse(await payloadFor(item)).success, item.file ?? item.schema).toBe(true);
    }
  });

  it("rejects every shared invalid fixture", async () => {
    const corpus = JSON.parse(await readFile(join(fixtureDirectory, "corpus.json"), "utf8")) as Corpus;
    for (const item of corpus.invalid) {
      expect(DemoSchemas[item.schema].safeParse(await payloadFor(item)).success, item.name).toBe(false);
    }
  });
});
