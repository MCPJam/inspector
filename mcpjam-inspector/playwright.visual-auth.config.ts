import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/visual",
  testMatch: ["auth.spec.ts", "staging-network.browser.ts"],
  outputDir: ".playwright/auth-check",
  workers: 1,
  retries: 0,
  // Staging cold starts can take minutes; the job's timeout-minutes is the
  // real ceiling.
  timeout: 600_000,
  expect: { timeout: 120_000 },
  reporter: "dot",
  use: {
    browserName: "chromium",
    trace: "off",
    video: "off",
    screenshot: "off",
    serviceWorkers: "block",
    actionTimeout: 120_000,
    navigationTimeout: 120_000,
  },
});
