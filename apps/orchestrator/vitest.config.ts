import { defineConfig } from "vitest/config";

// Unit tests only. Integration tests (test/integration/**/*.int.test.ts) need a
// real database / ffmpeg and run via the root vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**"],
  },
});
