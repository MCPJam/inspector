import { test } from "node:test";
import assert from "node:assert/strict";
import { childEnvironment } from "../process-environment.mjs";

test("package installs and app processes never inherit driver credentials", () => {
  assert.deepEqual(
    childEnvironment({
      PATH: "/bin",
      HOME: "/tmp",
      CANARY_API_KEY: "secret",
      CANARY_LOCAL_BEARER: "secret",
      CF_ACCESS_CLIENT_SECRET: "secret",
      NODE_AUTH_TOKEN: "secret",
      SLACK_ALERTS_WEBHOOK_URL: "secret",
      SENTRY_AUTH_TOKEN: "secret",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      GITHUB_SHA: "sha",
    }),
    { PATH: "/bin", HOME: "/tmp", GITHUB_SHA: "sha" }
  );
});
