import { defineConfig, devices } from "@playwright/test";

/**
 * The telemetry egress proof in a real Chromium: the hosted build with Sentry
 * and PostHog ON, every request to their endpoints intercepted, recorded,
 * decoded and searched for planted credentials (`e2e/telemetry/`).
 *
 * Unlike the smoke config there is no `webServer`: the spec serves the
 * telemetry build itself through `page.route` on `https://app.mcpjam.com`
 * and stands in for Convex, so nothing — no backend, no vendor — is reached
 * over the network. Build first:
 *
 *   npm run build:client:telemetry-e2e -w @mcpjam/inspector
 *   npm run test:e2e:telemetry -w @mcpjam/inspector
 */
export default defineConfig({
  testDir: "./e2e/telemetry",
  // `.browser.ts`, not `.spec.ts`: the smoke config (`playwright.config.ts`)
  // runs every spec under `e2e/`, and this one needs its own build.
  testMatch: /telemetry-egress\.browser\.ts/,
  timeout: 180_000,
  // One session at a time: every test waits out real SDK flush timers, and
  // parallel pages would only compete for the same CPU those timers need.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // No retries, deliberately. A leak that shows up one run in three is a leak;
  // a retry would turn it green.
  retries: 0,
  reporter: [
    ["list"],
    // Under the already-ignored report and results folders, beside the
    // smoke run's rather than on top of them.
    ["html", { open: "never", outputFolder: "playwright-report/telemetry" }],
  ],
  outputDir: "test-results/telemetry",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "https://app.mcpjam.com",
    // The full Chromium in its headless mode, not the default headless shell.
    // The shell reports a `HeadlessChrome` brand in
    // `navigator.userAgentData`, which posthog-js's bot filter drops every
    // event for (the device's user-agent string does not change it), so the
    // PostHog half of this proof would observe nothing. An explicit
    // executable below takes its place.
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? {}
      : { channel: "chromium" }),
    launchOptions: {
      // posthog-js drops every event when `navigator.webdriver` is true (its
      // bot filter); this flag makes it false, as for a real visitor. See
      // `e2e/telemetry/browser-harness.ts`.
      args: ["--disable-blink-features=AutomationControlled"],
      // CI's Playwright image ships the matching Chromium. A machine with a
      // different preinstalled build can point at it instead of installing.
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {}),
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
