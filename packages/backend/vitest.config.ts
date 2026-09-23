import { defineConfig } from "vitest/config";

// Backend unit/integration tests. Node environment (no DOM); explicit imports
// from "vitest" rather than globals. Live tests self-skip when unconfigured.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
