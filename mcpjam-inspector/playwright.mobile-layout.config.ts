import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

// These fixtures exercise DEV-only OAuth UI and synthetic MCP/browser transport.
// Keep them separate from the production/deployed smoke lane.
const externalURL = process.env.MOBILE_LAYOUT_BASE_URL;
const baseURL = externalURL ?? "http://localhost:5375";
export default defineConfig({
  testDir: "./e2e/visual",
  testMatch: /mobile-.*\.spec\.ts$/,
  outputDir:
    process.env.MOBILE_LAYOUT_RESULTS_DIR ??
    path.join(tmpdir(), "mcpjam-mobile-layout-results"),
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: {
    baseURL,
    browserName: "chromium",
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    serviceWorkers: "block",
  },
  webServer: externalURL
    ? undefined
    : {
        command: "node e2e/mobile-layout-server.mjs",
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          MCPJAM_RESOLVED_RUNTIME: "1",
          VITE_CONVEX_URL: "https://visual.invalid",
          VITE_WORKOS_CLIENT_ID: "client_mobile_fixture",
          VITE_WORKOS_REDIRECT_URI: `${baseURL}/callback`,
          VITE_DISABLE_POSTHOG_LOCAL: "true",
        },
      },
});
