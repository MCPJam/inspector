import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/visual",
  testMatch: ["auth.spec.ts", "staging-network.browser.ts"],
  outputDir: ".playwright/auth-check",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: "dot",
  use: {
    browserName: "chromium",
    trace: "off",
    video: "off",
    screenshot: "off",
    serviceWorkers: "block",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
});
