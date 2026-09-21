import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/api/src/**/*.integration.test.ts"],
    environment: "node",
    fileParallelism: false,
    passWithNoTests: false,
    reporters: ["default"]
  }
});
