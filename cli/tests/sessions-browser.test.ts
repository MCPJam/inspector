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
