import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

const commonEnv = {
  MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1",
  VITE_WORKOS_CLIENT_ID: "oauth-debugger-e2e-workos-client",
  VITE_CONVEX_URL: "https://oauth-debugger-e2e.convex.cloud",
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: /oauth-debugger\.spec\.ts/,
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
        baseURL: "http://localhost:5373",
      },
    },
    {
      name: "hosted",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: "http://localhost:5374",
      },
    },
  ],
  webServer: [
    {
      command: "npm run dev:app:default",
      url: "http://localhost:5373/__e2e/oauth-debugger",
      cwd: packageRoot,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...commonEnv,
        CLIENT_PORT: "5373",
        SERVER_PORT: "6473",
        VITE_API_BASE_URL: "http://localhost:6473",
        WEB_ALLOWED_ORIGINS: "http://localhost:5373,http://127.0.0.1:5373",
      },
    },
    {
      command: "npm run dev:app:default",
      url: "http://localhost:5374/__e2e/oauth-debugger",
      cwd: packageRoot,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...commonEnv,
        CLIENT_PORT: "5374",
        SERVER_PORT: "6474",
        VITE_API_BASE_URL: "http://localhost:6474",
        VITE_MCPJAM_HOSTED_MODE: "true",
        WEB_ALLOWED_ORIGINS: "http://localhost:5374,http://127.0.0.1:5374",
      },
    },
  ],
});
