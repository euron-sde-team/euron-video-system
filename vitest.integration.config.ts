import { defineConfig } from "vitest/config";

/**
 * Integration tests: real Postgres, no mocks. Requires TEST_DATABASE_URL.
 *
 * Files run serially (fileParallelism: false) because they share one database
 * and each file truncates it to establish its own starting state.
 */
export default defineConfig({
  test: {
    include: ["packages/*/test/integration/**/*.int.test.ts", "apps/*/test/integration/**/*.int.test.ts"],
    globalSetup: ["./tests/integration/global-setup.ts"],
    setupFiles: ["./tests/integration/env.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
