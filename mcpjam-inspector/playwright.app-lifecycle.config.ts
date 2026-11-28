import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "chat-app-conflict.browser.ts",
  outputDir: "test-results/app-lifecycle",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/app-lifecycle" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:6290",
    colorScheme: "light",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "node_modules/.bin/vite preview --config client/vite.config.ts --outDir ../dist/visual-hosted --host 127.0.0.1 --port 6290 --strictPort",
    url: "http://127.0.0.1:6290",
    reuseExistingServer: false,
    env: { MCPJAM_RESOLVED_RUNTIME: "1" },
  },
});
