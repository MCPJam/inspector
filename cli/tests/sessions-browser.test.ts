import assert from "node:assert/strict";
import test from "node:test";
import { browserInput } from "../src/commands/sessions-browser.js";
import { runCli } from "./support/cli-run.js";
test("browser flags opt in per turn and preserve explicit grant/profile", () => {
  assert.equal(browserInput({}), undefined);
  assert.deepEqual(browserInput({ browser: true }), {});
  assert.deepEqual(
    browserInput({
      browserMode: "allowlist",
      browserOrigins: ["https://example.com"],
      browserProfile: "profile",
    }),
    {
      policy: { mode: "allowlist", originAllowlist: ["https://example.com"] },
      profileId: "profile",
    }
  );
  assert.throws(() =>
    browserInput({ browserOrigins: ["https://example.com"] })
  );
  assert.throws(() => browserInput({ browserMode: "invalid" }));
});
test("cloud session browser exposes its commands", async () => {
  const result = await runCli(["cloud", "sessions", "browser", "--help"]);
  assert.equal(result.exitCode, 0, result.stderr);
  for (const verb of ["open", "navigate", "observe", "artifact", "close"])
    assert.match(result.stdout, new RegExp(verb));
});

test("new browser sessions require a caller-owned retry key", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Validation must not make a network request");
  });
  const result = await runCli([
    "cloud",
    "sessions",
    "browser",
    "open",
    "--project",
    "p",
    "--browser-mode",
    "read_only",
    "--api-key",
    "sk_test_fixture",
    "--api-url",
    "http://127.0.0.1:1/api/v1",
  ]);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr + result.stdout, /--idempotency-key is required/);
  assert.equal(fetch.mock.callCount(), 0);
});
