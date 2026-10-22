import { defineConfig } from "@playwright/test";

// The telemetry-enabled browser test. Its own config and its own CI job: the
// smoke suite builds with telemetry OFF (VITE_DISABLE_SENTRY, no PostHog
// capture), so it cannot show what a recording actually sends.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "telemetry-privacy.browser.ts",
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  use: {
    baseURL: "http://127.0.0.1:6291",
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    // The package's own Vite: the version @vitejs/plugin-react here targets.
    command:
      "node_modules/.bin/vite --config e2e/telemetry-privacy.vite.config.ts",
    url: "http://127.0.0.1:6291",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  reporter: "list",
});
