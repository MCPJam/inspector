import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_TEST_EXIT,
  localTestExitCodeForError,
  localTestExitCodeForResult,
} from "../src/lib/local-test-exit-code.js";
import { worstOf } from "../src/lib/eval-run-exit-code.js";

const issue = (category: string) => ({
  code: "X",
  phase: "execution" as const,
  category: category as never,
  message: "m",
});

test("refusals map by category — usage never goes through worstOf", () => {
  // The trap this module exists to avoid: worstOf does not know 2.
  assert.equal(worstOf([2]), 0);
  for (const category of [
    "usage",
    "unsupported",
    "import",
    "policy",
  ] as const) {
    assert.equal(
      localTestExitCodeForError({ category, phase: "validation" }),
      2,
      category
    );
  }
  assert.equal(
    localTestExitCodeForError({ category: "credentials", phase: "setup" }),
    3
  );
  assert.equal(
    localTestExitCodeForError({ category: "billing", phase: "setup" }),
    4
  );
  assert.equal(
    localTestExitCodeForError({ category: "setup", phase: "setup" }),
    4
  );
  assert.equal(
    localTestExitCodeForError({ category: "cancelled", phase: "setup" }),
    5
  );
  assert.equal(
    localTestExitCodeForError({ category: "integrity", phase: "reporting" }),
    5
  );
  // Unknown: 4 before execution, 5 after.
  assert.equal(
    localTestExitCodeForError({ category: "internal", phase: "setup" }),
    4
  );
  assert.equal(
    localTestExitCodeForError({ category: "internal", phase: "execution" }),
    5
  );
});

test("results: only a completed failed decision is 1", () => {
  assert.equal(
    localTestExitCodeForResult({ verdict: "passed", issues: [] }),
    0
  );
  assert.equal(
    localTestExitCodeForResult({ verdict: "failed", issues: [] }),
    1
  );
  assert.equal(
    localTestExitCodeForResult({ verdict: "inconclusive", issues: [] }),
    5
  );
  assert.equal(
    localTestExitCodeForResult({ verdict: "notEstablished", issues: [] }),
    5
  );
});

test("results merge what else was observed, in 1 > 3 > 4 > 5 > 0 order", () => {
  // A failed verdict plus an unwritable report is still a failure.
  assert.equal(
    localTestExitCodeForResult(
      { verdict: "failed", issues: [] },
      { artifactWriteFailed: true }
    ),
    1
  );
  // A pass whose report could not be written is a setup problem, not a pass.
  assert.equal(
    localTestExitCodeForResult(
      { verdict: "passed", issues: [] },
      { artifactWriteFailed: true }
    ),
    4
  );
  // A credential rejected during execution: the run stopped, not established.
  assert.equal(
    localTestExitCodeForResult({
      verdict: "notEstablished",
      issues: [issue("credentials")],
    }),
    3
  );
  assert.equal(
    localTestExitCodeForResult({
      verdict: "notEstablished",
      issues: [issue("billing")],
    }),
    4
  );
  assert.equal(
    localTestExitCodeForResult({
      verdict: "passed",
      issues: [issue("integrity")],
    }),
    5
  );
  // Cleanup and observer issues are reported, never a changed outcome.
  assert.equal(
    localTestExitCodeForResult({
      verdict: "passed",
      issues: [issue("cleanup"), issue("observer")],
    }),
    0
  );
  // Infrastructure is never 1.
  for (const category of [
    "credentials",
    "billing",
    "setup",
    "integrity",
    "internal",
  ]) {
    assert.notEqual(
      localTestExitCodeForResult({
        verdict: "notEstablished",
        issues: [issue(category)],
      }),
      LOCAL_TEST_EXIT.failed
    );
  }
});
