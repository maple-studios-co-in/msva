import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDemoContractArtifacts,
  writeDemoContractArtifacts
} from "./export-demo-contracts.js";

describe("demo contract artifact export", () => {
  it("writes deterministic artifacts that pass stale checking", async () => {
    const root = await mkdtemp(join(tmpdir(), "msva-contracts-"));
    await writeDemoContractArtifacts(root);
    await expect(checkDemoContractArtifacts(root)).resolves.toBeUndefined();
  });

  it("rejects a changed generated artifact without rewriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "msva-contracts-"));
    await writeDemoContractArtifacts(root);
    const target = join(root, "packages/contracts/json-schema/demo-v1/create-request.json");
    await writeFile(target, "{}\n", "utf8");
    await expect(checkDemoContractArtifacts(root)).rejects.toThrow("create-request.json");
  });

  it("rejects stale artifact names", async () => {
    const root = await mkdtemp(join(tmpdir(), "msva-contracts-"));
    await writeDemoContractArtifacts(root);
    const directory = join(root, "packages/contracts/json-schema/demo-v1");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "obsolete.json"), "{}\n", "utf8");
    await expect(checkDemoContractArtifacts(root)).rejects.toThrow("stale:");
  });

  it("embeds the canonical request and response shapes in OpenAPI", async () => {
    const root = await mkdtemp(join(tmpdir(), "msva-contracts-"));
    await writeDemoContractArtifacts(root);
    const openApi = JSON.parse(
      await readFile(join(root, "packages/contracts/openapi/demo-v1.json"), "utf8")
    ) as { components: { schemas: Record<string, unknown> } };
    for (const [component, filename] of [
      ["CreateRequestInput", "create-request.json"],
      ["CreateRequestResult", "create-request-result.json"],
      ["CallerContext", "caller-context.json"]
    ]) {
      const standalone = JSON.parse(
        await readFile(join(root, `packages/contracts/json-schema/demo-v1/${filename}`), "utf8")
      ) as { $id?: unknown; $schema?: unknown } & Record<string, unknown>;
      delete standalone.$id;
      delete standalone.$schema;
      expect(openApi.components.schemas[component]).toEqual(standalone);
    }
  });
});
