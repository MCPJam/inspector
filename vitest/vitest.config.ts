import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./tests/support/eval-identity.ts"],
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // These tests call the SDK's EvalTest.run(), which would otherwise post `eval_test_run_triggered` to production PostHog as customer usage.
    env: { DO_NOT_TRACK: "1" },
  },
});
