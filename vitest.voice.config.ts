import { defineConfig } from "vitest/config";

// Mounted-route tests call production modules that use the shared default
// Prisma client, which reads DATABASE_URL. Point it at the same disposable
// voice database the tests seed, never at another suite's database.
const voiceDatabaseUrl = process.env.MSVA_VOICE_TEST_DATABASE_URL;

export default defineConfig({
  test: {
    include: ["apps/api/src/**/*.voice.integration.test.ts"],
    environment: "node",
    env: voiceDatabaseUrl ? { DATABASE_URL: voiceDatabaseUrl } : {},
    fileParallelism: false,
    passWithNoTests: false,
    reporters: ["default"],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
