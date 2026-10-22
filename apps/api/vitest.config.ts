import { defineConfig } from "vitest/config";

/**
 * Unit tests only. Integration tests (test/integration/*.int.test.ts) need a
 * real Postgres and run from the repo root via vitest.integration.config.ts.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**"],
    setupFiles: ["./test/setup-env.ts"],
  },
});
