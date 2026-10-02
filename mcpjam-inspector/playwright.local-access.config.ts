import { defineConfig, devices } from "@playwright/test";
const port = process.env.LOCAL_ACCESS_TEST_PORT ?? "6284";
const baseURL =
  process.env.LOCAL_ACCESS_TEST_BASE_URL ?? `http://127.0.0.1:${port}`;
const token = "local-access-e2e-credential-32chars";
process.env.MCPJAM_SESSION_TOKEN = token;
export default defineConfig({
  testDir: "./e2e",
  testMatch: "local-access.spec.ts",
  forbidOnly: !!process.env.CI,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.LOCAL_ACCESS_TEST_BASE_URL
    ? undefined
    : {
        command: `node bin/start.js --port ${port} --no-open`,
        url: `${baseURL}/health`,
        reuseExistingServer: !process.env.CI,
        env: {
          NODE_ENV: "production",
          VITE_MCPJAM_HOSTED_MODE: "false",
          MCPJAM_SESSION_TOKEN: token,
          MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1",
        },
      },
});
