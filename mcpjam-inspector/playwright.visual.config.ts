import { defineConfig } from "@playwright/test";
import type { ChromaticConfig } from "@chromatic-com/playwright";

export default defineConfig<ChromaticConfig>({
  testDir: "./e2e/visual",
  testMatch: ["app.spec.ts"],
  outputDir: ".playwright/visual-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:6289",
    browserName: "chromium",
    serviceWorkers: "block",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    trace: "off",
    video: "off",
    screenshot: "off",
    disableAutoSnapshot: true,
    prefersReducedMotion: "reduce",
    pauseAnimationAtEnd: true,
  },
  projects: [
    {
      name: "chromium-light",
      grep: /inspector light:/,
      use: { colorScheme: "light" },
    },
    {
      name: "chromium-dark",
      grep: /inspector dark:/,
      use: { colorScheme: "dark" },
    },
    {
      name: "hosted-light",
      grep: /product light:/,
      use: { baseURL: "http://127.0.0.1:6290", colorScheme: "light" },
    },
    {
      name: "hosted-dark",
      grep: /product dark:/,
      use: { baseURL: "http://127.0.0.1:6290", colorScheme: "dark" },
    },
  ],
  webServer: [
    {
      command:
        "node_modules/.bin/vite preview --config client/vite.config.ts --host 127.0.0.1 --port 6289 --strictPort",
      url: "http://127.0.0.1:6289",
      reuseExistingServer: false,
      env: { MCPJAM_RESOLVED_RUNTIME: "1" },
    },
    {
      command:
        "node_modules/.bin/vite preview --config client/vite.config.ts --outDir ../dist/visual-hosted --host 127.0.0.1 --port 6290 --strictPort",
      url: "http://127.0.0.1:6290",
      reuseExistingServer: false,
      env: { MCPJAM_RESOLVED_RUNTIME: "1" },
    },
  ],
});
