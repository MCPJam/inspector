import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

// When PLAYWRIGHT_BASE_URL is set (e.g. the post-deploy staging lane), tests run
// against that deployed URL and no local server is booted. Otherwise we boot the
// inspector in production mode and drive it on the default port.
const deployedBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = deployedBaseUrl ?? "http://localhost:6274";

// Resolve to the inspector package root (this config's directory) so the booted
// webServer runs the workspace's `npm run start` regardless of the invoking cwd.
const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // One browser for now; the array leaves room for firefox/webkit later.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Boot a local production server only when not targeting a deployed URL.
  webServer: deployedBaseUrl
    ? undefined
    : {
        command: "npm run start -- --no-open",
        url: baseURL,
        cwd: packageRoot,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          NODE_ENV: "production",
          MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1",
        },
      },
});
