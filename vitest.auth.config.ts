import { defineConfig } from "vitest/config";

// Auth tests truncate users, sessions and login codes, so they only run
// against their own disposable database (see pnpm test:auth-db).
export default defineConfig({
  test: {
    include: ["apps/api/src/**/*.auth.integration.test.ts"],
    environment: "node",
    fileParallelism: false,
    passWithNoTests: false,
    reporters: ["default"],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
