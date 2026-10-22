import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PHASES } from "./review-common.mjs";

const workflow = (file) => readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");

test("the pipeline's workflow_run triggers name exactly the workflows its phases gate on", () => {
  // PHASES lists workflow files, the trigger lists display names; renaming
  // either without the other would silently stop a phase from being gated.
  const triggers = /workflow_run:\s*\n\s*workflows: \[([^\]]*)\]/.exec(workflow("adversarial-review.yml"))[1]
    .split(",").map((name) => name.trim());
  const gated = PHASES.flatMap((phase) => phase.workflows)
    .map((file) => /^name: (.+)$/m.exec(workflow(file))[1].trim());
  assert.deepEqual([...triggers].sort(), [...gated].sort());
});
