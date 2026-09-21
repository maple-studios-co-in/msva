import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["apps/api/src/auth.integration.test.ts"], environment: "node", passWithNoTests: false } });
