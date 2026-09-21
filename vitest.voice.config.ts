import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["apps/api/src/**/*.voice.integration.test.ts"], environment: "node", passWithNoTests: false, reporters: ["default"], testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false } });
