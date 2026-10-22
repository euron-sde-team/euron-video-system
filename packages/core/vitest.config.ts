import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup-env.ts"],
    include: ["test/**/*.test.ts"],
    // Integration tests need Postgres; they run via the root vitest.integration.config.ts.
    exclude: ["test/integration/**"],
  },
});
