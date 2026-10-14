import { test } from "node:test";
import assert from "node:assert/strict";
import { autofixRounds, decide, gate, tipIsReviewFix } from "./review-gate.mjs";
import { phaseMarker } from "./review-common.mjs";

const SHA = "a".repeat(40);
const run = (file, conclusion, extra = {}) => ({
  id: file.length, name: file, path: `.github/workflows/${file}`, run_number: 1, run_attempt: 1,
  status: conclusion ? "completed" : "in_progress", conclusion, ...extra,
});
const green = ["test.yml", "lint.yml", "pr-size.yml", "ui-copy-review.yml", "slop-ratchet.yml"].map((file) => run(file, "success"));
const replace = (runs, file, conclusion) => [...runs.filter((entry) => !entry.path.endsWith(file)), run(file, conclusion)];
const none = new Set();

test("phases run in order: a failing CI phase is triaged before the quality checks", () => {
  const runs = replace(replace(green, "lint.yml", "failure"), "slop-ratchet.yml", "failure");
  assert.deepEqual(decide({ runs, reviewFix: false, reviewed: none }), { phase: "ci", status: "fail" });
});

test("the quality phase waits until CI passed, and fails on its own", () => {
  assert.deepEqual(decide({ runs: replace(green, "test.yml", null), reviewFix: false, reviewed: none }), { phase: "ci", status: "wait" });
  assert.deepEqual(decide({ runs: replace(green, "pr-size.yml", "failure"), reviewFix: false, reviewed: none }), { phase: "quality", status: "fail" });
  assert.deepEqual(decide({ runs: green.filter((entry) => !entry.path.endsWith("pr-size.yml")), reviewFix: false, reviewed: none }),
    { phase: "quality", status: "wait" });
});

test("a cancelled run waits for its replacement, and the newest attempt wins", () => {
  assert.equal(decide({ runs: replace(green, "test.yml", "cancelled"), reviewFix: false, reviewed: none }).status, "wait");
  const retried = [...replace(green, "test.yml", "failure"), run("test.yml", "success", { run_attempt: 2 })];
  assert.deepEqual(decide({ runs: retried, reviewFix: false, reviewed: none }), { phase: "review", status: "run" });
});

test("the review runs once checks pass, never on a bot autofix, and never twice per commit", () => {
  assert.deepEqual(decide({ runs: green, reviewFix: false, reviewed: none }), { phase: "review", status: "run" });
  assert.deepEqual(decide({ runs: green, reviewFix: true, reviewed: none }), { phase: "review", status: "skip" });
  assert.deepEqual(decide({ runs: green, reviewFix: false, reviewed: new Set(["review"]) }), { phase: "review", status: "done" });
  const failed = replace(green, "test.yml", "failure");
  assert.equal(decide({ runs: failed, reviewFix: true, reviewed: none }).status, "fail");
});

test("only the review's own autofix at the tip skips the review; a CI autofix that turns checks green does not", async (t) => {
  const commit = (message) => ({ commit: { message } });
  assert.equal(tipIsReviewFix([commit("Fix\n\nReview-Pipeline-Autofix: review")]), true);
  assert.equal(tipIsReviewFix([commit("Fix\n\nReview-Pipeline-Autofix: ci")]), false);
  assert.equal(tipIsReviewFix([commit("Fix\n\nReview-Pipeline-Autofix: review"), commit("human")]), false);
  process.env.PR_NUMBER = "7";
  t.after(() => delete process.env.PR_NUMBER);
  const ciFix = commit("Fix lint\n\nReview-Pipeline-Autofix: ci");
  const result = await gate(fakeGitHub({ commits: [commit("feat"), ciFix] }), SHA, "o/r");
  assert.deepEqual([result.proceed, result.phase, result.rounds], [true, "review", 1]);
});

test("autofix rounds count only the bot commits at the tip", () => {
  const commit = (message) => ({ commit: { message } });
  const fix = commit("Fix typo\n\nReview-Pipeline-Autofix: review");
  assert.equal(autofixRounds([commit("feat"), fix, fix]), 2);
  assert.equal(autofixRounds([fix, commit("human change")]), 0);
});

function fakeGitHub({ pr = {}, runs = green, reviews = [], commits = [] } = {}) {
  const pull = { number: 7, state: "open", draft: false, head: { sha: SHA, ref: "feature", repo: { full_name: "o/r" } }, base: { sha: "b".repeat(40) }, ...pr };
  return async (path) => {
    if (path.startsWith("pulls/7/reviews")) return reviews;
    if (path.startsWith("pulls/7/commits")) return commits;
    if (path.startsWith("pulls/7")) return pull;
    if (path.startsWith("actions/runs")) return { workflow_runs: runs };
    if (path.startsWith("compare/")) return { merge_base_commit: { sha: "c".repeat(40) } };
    throw new Error(`unexpected ${path}`);
  };
}

test("the gate resolves the merge base and the failed runs of the phase it picked", async (t) => {
  process.env.PR_NUMBER = "7";
  t.after(() => delete process.env.PR_NUMBER);
  const result = await gate(fakeGitHub({ runs: replace(green, "lint.yml", "failure") }), SHA, "o/r");
  assert.equal(result.proceed, true);
  assert.equal(result.phase, "ci");
  assert.equal(result.mergeBase, "c".repeat(40));
  assert.equal(result.autofix, true);
  assert.deepEqual(result.failedRuns.map((entry) => entry.file), ["lint.yml"]);
});

test("the gate stops for drafts, forks, stale heads, waiting phases and phases already triaged", async (t) => {
  process.env.PR_NUMBER = "7";
  t.after(() => delete process.env.PR_NUMBER);
  for (const pr of [{ draft: true }, { state: "closed" }, { head: { sha: "d".repeat(40), repo: { full_name: "o/r" } } },
    { head: { sha: SHA, ref: "x", repo: { full_name: "fork/r" } } }]) {
    assert.equal((await gate(fakeGitHub({ pr }), SHA, "o/r")).proceed, false);
  }
  assert.equal((await gate(fakeGitHub({ runs: replace(green, "test.yml", null) }), SHA, "o/r")).proceed, false);
  const reviews = [{ user: { type: "User" }, body: phaseMarker("review", SHA) }];
  assert.equal((await gate(fakeGitHub({ reviews }), SHA, "o/r")).proceed, true, "a person's copy of the marker does not count");
  reviews.push({ user: { type: "Bot" }, body: phaseMarker("review", SHA) });
  assert.equal((await gate(fakeGitHub({ reviews }), SHA, "o/r")).proceed, false);
});

test("after the autofix limit the gate still triages, but without autofix", async (t) => {
  process.env.PR_NUMBER = "7";
  t.after(() => delete process.env.PR_NUMBER);
  const fix = { commit: { message: "Fix\n\nReview-Pipeline-Autofix: ci" } };
  const result = await gate(fakeGitHub({ runs: replace(green, "test.yml", "failure"), commits: [fix, fix] }), SHA, "o/r");
  assert.equal(result.proceed, true);
  assert.equal(result.autofix, false);
});
