import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSmokeRun } from "./check-release.mjs";

const sha = "a".repeat(40);
const successful = {
  repository: { full_name: "MCPJam/inspector" },
  path: ".github/workflows/evals-action-smoke.yml",
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  event: "workflow_dispatch",
};

test("release requires a successful live smoke for the exact commit", () => {
  assert.doesNotThrow(() => checkSmokeRun(successful, sha));
  for (const change of [
    { head_sha: "b".repeat(40) },
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { status: "in_progress" },
    { event: "pull_request" },
    { repository: { full_name: "someone/inspector" } },
    { path: ".github/workflows/evals-action-test.yml" },
  ])
    assert.throws(() => checkSmokeRun({ ...successful, ...change }, sha));
  assert.throws(() => checkSmokeRun(successful, "main"));
});
