import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { VoiceSchemas } from "./voice.js";
import { CreateRequestResultSchema } from "./demo.js";

const root = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const entries = Object.entries(VoiceSchemas);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
function artifacts(): Record<string, string> {
  const schemas = { ...Object.fromEntries(entries.map(([name, schema]) => [name, canonical(z.toJSONSchema(schema, { target: "draft-2020-12" }))])), CreateRequestResult: canonical(z.toJSONSchema(CreateRequestResultSchema, { target: "draft-2020-12" })) };
  const result: Record<string, string> = {};
  for (const [name, schema] of Object.entries(schemas)) result[`packages/contracts/json-schema/voice-v1/${name}.json`] = `${JSON.stringify({ $id: `https://msva.example.invalid/contracts/voice-v1/${name}`, $schema: "https://json-schema.org/draft/2020-12/schema", ...(schema as object) }, null, 2)}\n`;
  const call = { name: "callId", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 128 } };
  const errors = { "400": { description: "Invalid request" }, "401": { description: "Invalid credential" }, "403": { description: "Credential scope denied" }, "404": { description: "Unknown call or receipt" }, "409": { description: "Fenced, stale, or conflicting operation" }, "503": { description: "Voice service unavailable" } };
  const json = (name: string) => ({ content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } } });
  const operation = (body: string | undefined, response: string, scoped = true) => ({
    security: [{ [scoped ? "callLease" : "workerBearer"]: [] }],
    ...(body ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${body}` } } } } } : {}),
    responses: { "200": { description: "Committed response", ...json(response) }, ...errors }
  });
  const openapi = { openapi: "3.1.0", info: { title: "MSVA voice worker contracts", version: "v1" }, components: { securitySchemes: { workerBearer: { type: "http", scheme: "bearer", description: "Global worker credential; claim only." }, callLease: { type: "http", scheme: "bearer", description: "Call-scoped epoch lease credential." } }, schemas }, paths: { "/leases/claim": { post: operation("VoiceLeaseClaim", "VoiceLease", false) }, "/calls/{callId}/context": { get: { parameters: [call], ...operation(undefined, "VoiceContext") } }, "/calls/{callId}/lease/renew": { post: { parameters: [call], ...operation("VoiceLeaseRenew", "VoiceLease") } }, "/calls/{callId}/events": { post: { parameters: [call], ...operation("WorkerEvent", "VoiceEventReceipt") } }, "/calls/{callId}/tools": { post: { parameters: [call], ...operation("VoiceTool", "CreateRequestResult") } }, "/calls/{callId}/tools/{invocationId}": { get: { parameters: [call, { name: "invocationId", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 128 } }], ...operation(undefined, "CreateRequestResult") } } } };
  result["packages/contracts/openapi/voice-v1.json"] = `${JSON.stringify(canonical(openapi), null, 2)}\n`;
  return result;
}
async function main() { const write = process.argv[2] === "--write"; const expected = artifacts(); const bad: string[] = []; for (const [file, body] of Object.entries(expected)) { const target = join(root, file); if (write) { await mkdir(dirname(target), { recursive: true }); await writeFile(target, body); } else { try { if (await readFile(target, "utf8") !== body) bad.push(file); } catch { bad.push(file); } } } if (!write && bad.length) throw new Error(`Voice contract artifacts are stale: ${bad.join(", ")}`); }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
