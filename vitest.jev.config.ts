import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/api/src/**/*.integration.test.ts"],
    exclude: ["apps/api/src/**/*.voice.integration.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"]
  }
});
