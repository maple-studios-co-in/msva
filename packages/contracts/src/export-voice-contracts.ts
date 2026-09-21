import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { VoiceSchemas } from "./voice.js";

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const entries = Object.entries(VoiceSchemas);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
function artifacts(): Record<string, string> {
  const schemas = Object.fromEntries(entries.map(([name, schema]) => [name, canonical(z.toJSONSchema(schema, { target: "draft-2020-12" }))]));
  const result: Record<string, string> = {};
  for (const [name, schema] of Object.entries(schemas)) result[`packages/contracts/json-schema/voice-v1/${name}.json`] = `${JSON.stringify({ $id: `https://msva.example.invalid/contracts/voice-v1/${name}`, $schema: "https://json-schema.org/draft/2020-12/schema", ...(schema as object) }, null, 2)}\n`;
  result["packages/contracts/openapi/voice-v1.json"] = `${JSON.stringify(canonical({ openapi: "3.1.0", info: { title: "MSVA voice worker contracts", version: "v1" }, components: { securitySchemes: { workerBearer: { type: "http", scheme: "bearer" } }, schemas }, paths: { "/leases/claim": { post: { security: [{ workerBearer: [] }] } }, "/calls/{callId}/context": { get: { security: [{ workerBearer: [] }] } }, "/calls/{callId}/lease/renew": { post: { security: [{ workerBearer: [] }] } }, "/calls/{callId}/events": { post: { security: [{ workerBearer: [] }] } }, "/calls/{callId}/tools": { post: { security: [{ workerBearer: [] }] } } } }), null, 2)}\n`;
  return result;
}
async function main() { const write = process.argv[2] === "--write"; const expected = artifacts(); const bad: string[] = []; for (const [file, body] of Object.entries(expected)) { const target = join(root, file); if (write) { await mkdir(dirname(target), { recursive: true }); await writeFile(target, body); } else { try { if (await readFile(target, "utf8") !== body) bad.push(file); } catch { bad.push(file); } } } if (!write && bad.length) throw new Error(`Voice contract artifacts are stale: ${bad.join(", ")}`); }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
