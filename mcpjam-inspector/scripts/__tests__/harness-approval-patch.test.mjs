import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  installApprovalPatch,
  patchAgent,
  patchAcp,
} from "../patch-harness-approvals.mjs";

const require = createRequire(import.meta.url);
test("the pinned approval patch is installed and idempotent", () => {
  installApprovalPatch();
  for (const [name, file, patch] of [
    ["@ai-sdk/harness", "dist/agent/index.js", patchAgent],
    ["@ai-sdk/harness-acp", "dist/index.js", patchAcp],
  ]) {
    const source = readFileSync(
      join(dirname(require.resolve(`${name}/package.json`)), file),
      "utf8",
    );
    assert.equal(patch(source), source);
  }
});

test("an unrecognized runtime cannot silently skip the approval correction", () => {
  assert.throws(() => patchAgent("different runtime"), /no longer matches/);
  assert.throws(() => patchAcp("different runtime"), /no longer matches/);
});
