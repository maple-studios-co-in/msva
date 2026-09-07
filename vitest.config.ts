import { defineConfig } from "vitest/config";

// Single root config for the whole workspace. Tests live next to the code they
// cover as *.test.ts, so a reader opening a module can see its contract in the
// file beside it.
export default defineConfig({
  test: {
    include: ["apps/**/src/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"]
  }
});
