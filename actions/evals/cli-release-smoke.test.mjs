import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolveSmokeCliVersion } from "./cli-release-smoke.mjs";

test("post-publish smoke refuses registry lag instead of testing the old CLI", async () => {
  assert.equal(
    await resolveSmokeCliVersion("6", "6.4.5", async () => "6.4.5"),
    "6.4.5",
  );
  await assert.rejects(
    resolveSmokeCliVersion("6", "6.4.5", async () => "6.4.4"),
    /published CLI/,
  );
  assert.equal(
    await resolveSmokeCliVersion("6", "7.0.0", async () => "6.4.5"),
    "6.4.5",
  );
  assert.equal(
    await resolveSmokeCliVersion("6", undefined, async () => "6.4.5"),
    "6.4.5",
  );
});

test("every CLI publish runs the action smoke after publication, even without action edits", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const smoke = workflow.match(
    /\n  evals-cli-release-smoke:\n([\s\S]*?)(?=\n  [\w-]+:)/,
  )?.[1];
  assert.ok(smoke);
  assert.match(smoke, /needs: \[preflight, verified, publish-packages\]/);
  assert.match(smoke, /outputs\.publish_cli == 'true'/);
  assert.doesNotMatch(smoke, /evals_action_changed/);
  assert.match(smoke, /needs\.publish-packages\.result == 'success'/);
  assert.match(smoke, /verify-published-cli: true/);
  const called = await readFile(
    new URL("../../.github/workflows/evals-action-smoke.yml", import.meta.url),
    "utf8",
  );
  assert.match(called, /resolveSmokeCliVersion/);
  assert.match(called, /cli-version: \$\{\{ steps\.cli\.outputs\.version \}\}/);
  const finish = workflow.slice(workflow.indexOf("\n  announce-finish:"));
  assert.match(finish.split("\n    if:")[0], /evals-cli-release-smoke/);
});
