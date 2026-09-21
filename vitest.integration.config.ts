import { defineConfig } from "vitest/config";

// PostgreSQL integration tests are intentionally separate from the normal unit
// suite. They require MSVA_TEST_DATABASE_URL and create their own disposable
// schemas; passWithNoTests remains false so this gate cannot be skipped.
export default defineConfig({
  test: {
    include: ["packages/db/src/**/*.integration.test.ts"],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
