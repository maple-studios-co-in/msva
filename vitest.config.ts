import { defineConfig } from "vitest/config";

// Single root config for the whole workspace. Tests live next to the code they
// cover as *.test.ts, so a reader opening a module can see its contract in the
// file beside it.
export default defineConfig({
  test: {
    include: ["apps/**/src/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress}.config.*",
      "**/*.integration.test.ts"
    ],
    environment: "node",
    passWithNoTests: false,
    reporters: ["default"]
  }
});
