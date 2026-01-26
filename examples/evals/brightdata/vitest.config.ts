import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 180000, // 3 minutes for long-running evals
    hookTimeout: 60000, // 1 minute for setup/teardown
  },
});
