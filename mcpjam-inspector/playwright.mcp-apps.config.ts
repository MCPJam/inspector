import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * The MCP Apps view-mount suite runs against a DEV server: its harness lives at
 * `/__e2e/mcp-app-view`, a route registered only when `import.meta.env.DEV` is
 * set. Ports are its own so it can run beside the oauth-debugger config.
 *
 * `mountMode` is a harness query parameter rather than a second server with
 * `VITE_MCPJAM_VIEW_MOUNT=srcdoc`, so both mount paths are covered by one
 * browser against one build.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /mcp-app-view-origin\.spec\.ts/,
  timeout: 90_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "dev",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://localhost:5375",
      },
    },
  ],
  webServer: [
    {
      command: "npm run dev:app:default",
      url: "http://localhost:5375/__e2e/mcp-app-view",
      cwd: packageRoot,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1",
        VITE_WORKOS_CLIENT_ID: "mcp-apps-e2e-workos-client",
        VITE_CONVEX_URL: "https://mcp-apps-e2e.convex.cloud",
        CLIENT_PORT: "5375",
        SERVER_PORT: "6475",
        VITE_API_BASE_URL: "http://localhost:6475",
        WEB_ALLOWED_ORIGINS: "http://localhost:5375,http://127.0.0.1:5375",
        CLIENT_CACHE_DIR: "node_modules/.vite-mcp-apps-e2e",
      },
    },
  ],
});
