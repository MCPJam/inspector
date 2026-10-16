import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("..", import.meta.url));
export default defineConfig({
  testDir: ".",
  testMatch: "local-harness.browser.ts",
  workers: 1,
  timeout: 60_000,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/local-harness", open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:6316",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    },
  },
  webServer: [
    {
      command:
        "LOCAL_HARNESS_BROWSER_SERVER=1 npx vitest run --config e2e/local-harness-server.vitest.config.ts",
      cwd,
      url: "http://127.0.0.1:6315/health",
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        "node node_modules/vite/bin/vite.js --config e2e/local-harness.vite.config.ts",
      cwd,
      url: "http://127.0.0.1:6316",
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
