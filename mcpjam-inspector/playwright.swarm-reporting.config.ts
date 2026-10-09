import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "swarm-reporting.browser.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:6289",
    headless: true,
    viewport: { width: 1280, height: 1000 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "../node_modules/.bin/vite --config e2e/swarm-reporting.vite.config.ts",
    url: "http://127.0.0.1:6289",
    reuseExistingServer: false,
  },
  reporter: "list",
});
