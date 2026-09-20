import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DemoSchemas } from "./demo.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ArtifactMap = Record<string, string>;

const schemaFiles = {
  "language.json": "Language",
  "journey-kind.json": "JourneyKind",
  "truth-state.json": "TruthState",
  "identity-assurance.json": "IdentityAssurance",
  "create-request.json": "CreateRequestInput",
  "create-request-result.json": "CreateRequestResult",
  "demo-error.json": "DemoError",
  "caller-context-input.json": "CallerContextInput",
  "caller-context.json": "CallerContext",
  "source-result.json": "SourceResult",
  "evidence.json": "Evidence",
  "handoff.json": "Handoff",
  "risk-assessment.json": "RiskAssessment"
} as const satisfies Record<string, keyof typeof DemoSchemas>;

const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

function json(value: JsonValue): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function generatedSchema(schema: z.ZodType, filename: string): Record<string, JsonValue> {
  const result = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, JsonValue>;
  return {
    $id: `https://msva.example.invalid/contracts/demo-v1/${filename}`,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...result
  };
}

function withoutDocumentMetadata(schema: Record<string, JsonValue>): Record<string, JsonValue> {
  const { $id: _id, $schema: _schema, ...component } = schema;
  return component;
}

function openApi(schemas: Record<string, Record<string, JsonValue>>): Record<string, JsonValue> {
  const components = Object.fromEntries(
    Object.entries(schemaFiles).map(([filename, name]) => [
      name,
      withoutDocumentMetadata(schemas[filename]!)
    ])
  );
  const callIdParameter = {
    name: "callId",
    in: "path",
    required: true,
    schema: { type: "string", minLength: 1, maxLength: 128 },
    description: "Durable application call identity. The route is planned and unmounted."
  };
  return {
    openapi: "3.1.0",
    info: { title: "MSVA demo foundation contracts", version: "v1" },
    components: {
      securitySchemes: {
        serviceBearer: { type: "http", scheme: "bearer", bearerFormat: "service-token" }
      },
      schemas: components
    },
    paths: {
      "/v1/calls/{callId}/demo-context": {
        post: {
          "x-implementation-status": "planned-unmounted",
          security: [{ serviceBearer: [] }],
          parameters: [callIdParameter],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CallerContextInput" } } }
          },
          responses: {
            "200": {
              description: "Confirmed caller context when future policy allows disclosure.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CallerContext" } } }
            },
            "400": {
              description: "Invalid context request.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DemoError" } } }
            },
            "401": {
              description: "Missing or invalid service authorization.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DemoError" } } }
            },
            "403": {
              description: "The service is not authorized for this call-scoped context.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DemoError" } } }
            },
            "404": {
              description: "The call does not exist.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DemoError" } } }
            }
          }
        }
      },
      "/v1/calls/{callId}/demo-requests": {
        post: {
          "x-implementation-status": "planned-unmounted",
          security: [{ serviceBearer: [] }],
          parameters: [
            callIdParameter,
            {
              name: "X-MSVA-Call-Lease",
              in: "header",
              required: true,
              schema: { type: "string", minLength: 1, maxLength: 128 }
            }
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateRequestInput" } } }
          },
          responses: {
            "201": {
              description: "Durable request receipt only; staff work remains pending.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/CreateRequestResult" } } }
            },
            "400": {
              description: "Rejected request.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DemoError" } } }
            },
            "409": {
              description: "Idempotency conflict.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DemoError" } } }
            },
            "503": {
              description: "Temporary persistence failure.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DemoError" } } }
            }
          }
        }
      }
    }
  };
}

export function buildDemoContractArtifacts(): ArtifactMap {
  const schemas = Object.fromEntries(
    Object.entries(schemaFiles).map(([filename, name]) => [filename, generatedSchema(DemoSchemas[name], filename)])
  ) as Record<string, Record<string, JsonValue>>;
  const artifacts: ArtifactMap = Object.fromEntries(
    Object.entries(schemas).map(([filename, schema]) => [
      `packages/contracts/json-schema/demo-v1/${filename}`,
      json(schema)
    ])
  );
  artifacts["packages/contracts/openapi/demo-v1.json"] = json(openApi(schemas));
  return artifacts;
}

export async function writeDemoContractArtifacts(root = repositoryRoot): Promise<void> {
  const artifacts = buildDemoContractArtifacts();
  const schemaDirectory = join(root, "packages/contracts/json-schema/demo-v1");
  await mkdir(schemaDirectory, { recursive: true });
  const expectedSchemaNames = new Set(
    Object.keys(artifacts)
      .filter((path) => path.startsWith("packages/contracts/json-schema/demo-v1/"))
      .map((path) => path.split("/").at(-1)!)
  );
  for (const entry of await readdir(schemaDirectory)) {
    if (entry.endsWith(".json") && !expectedSchemaNames.has(entry)) {
      await rm(join(schemaDirectory, entry));
    }
  }
  await Promise.all(
    Object.entries(artifacts).map(async ([relativePath, contents]) => {
      const target = join(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    })
  );
}

export async function checkDemoContractArtifacts(root = repositoryRoot): Promise<void> {
  const expected = buildDemoContractArtifacts();
  const actualPaths = new Set<string>();
  const schemaDirectory = join(root, "packages/contracts/json-schema/demo-v1");
  try {
    for (const entry of await readdir(schemaDirectory)) {
      if (entry.endsWith(".json")) actualPaths.add(`packages/contracts/json-schema/demo-v1/${entry}`);
    }
  } catch {
    // Missing directories are reported together with missing files below.
  }
  actualPaths.add("packages/contracts/openapi/demo-v1.json");
  const mismatches: string[] = [];
  for (const [relativePath, contents] of Object.entries(expected)) {
    try {
      if ((await readFile(join(root, relativePath), "utf8")) !== contents) mismatches.push(relativePath);
    } catch {
      mismatches.push(relativePath);
    }
    actualPaths.delete(relativePath);
  }
  for (const stalePath of actualPaths) {
    try {
      await readFile(join(root, stalePath), "utf8");
      mismatches.push(`stale:${stalePath}`);
    } catch {
      // The OpenAPI path was included only to detect a stale/missing expected file.
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Demo contract artifacts are stale: ${mismatches.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "--write") return writeDemoContractArtifacts();
  if (command === "--check") return checkDemoContractArtifacts();
  throw new Error("Usage: export-demo-contracts.ts --write|--check");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
