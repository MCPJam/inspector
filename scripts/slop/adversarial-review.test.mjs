import { test } from "node:test";
import assert from "node:assert/strict";
import { collectContext, ReviewBudgetError, runReview } from "./adversarial-review.mjs";

test("collects full before/after blobs and treats additions, deletions and symlinks as data", () => {
  const readBlobs = [];
  const runGit = ([command, ...args]) => {
    if (command === "diff") return args.includes("--name-only") ? "added.js\0deleted.js\0link\0" : "patch";
    if (command === "ls-tree") {
      const [ref, , path] = args;
      if ((ref === "base" && path.endsWith("added.js")) ||
          (ref === "head" && path.endsWith("deleted.js"))) return "";
      return path.endsWith("link") ? "120000 blob abc\tlink" : "100644 blob abc\tfile";
    }
    readBlobs.push(args[0]);
    return "complete file contents";
  };
  const files = collectContext("base", "head", runGit);
  assert.equal(files[0].before, null);
  assert.equal(files[0].after, "complete file contents");
  assert.equal(files[1].after, null);
  assert.equal(files[2].after, "[non-regular file omitted]");
  assert.deepEqual(readBlobs, ["head:added.js", "base:deleted.js"]);
});

test("a file too large for the budget is sent as its diff and marked, smallest files first", () => {
  const sizes = { "large.js": 300_000, "medium.js": 150_000, "small.js": 10 };
  const files = collectContext("base", "head", ([command, ...args]) => {
    if (command === "diff") return args.includes("--name-only") ? "large.js\0medium.js\0small.js\0" : "patch";
    if (command === "ls-tree") return "100644 blob abc\tfile";
    return "x".repeat(sizes[args[0].split(":")[1]]);
  });
  assert.deepEqual(files.map((file) => [file.path, file.diffOnly === true]),
    [["large.js", true], ["medium.js", false], ["small.js", false]]);
  assert.equal(files[0].diff, "patch");
  assert.match(files[0].after, /omitted to fit the review budget/);
});

test("a diff over the budget on its own skips the review instead of truncating it", () => {
  assert.throws(() => collectContext("base", "head", ([command, ...args]) => {
    if (command === "diff") return args.includes("--name-only") ? "large.js\0" : "x".repeat(500_001);
    if (command === "ls-tree") return "100644 blob abc\tlarge.js";
    return "small";
  }), (error) => error instanceof ReviewBudgetError && /review budget/.test(error.message));
});

const oneFile = ([command, ...args]) => {
  if (command === "diff") return args.includes("--name-only") ? "file.js\0" : "patch";
  if (command === "ls-tree") return "100644 blob abc\tfile.js";
  return "contents";
};

test("the review returns structured findings and sends the PR as data", async () => {
  const finding = { severity: "warning", title: "Unbounded retry", path: "file.js", snippet: "contents",
    problem: "p", fix: "f", test: "t", personas: ["Saboteur"] };
  const review = await runReview({
    base: "base", head: "head", runGit: oneFile,
    call: async (input) => {
      assert.equal(input.model.id, "claude-sonnet-5-5");
      assert.equal(input.effort, "high");
      assert.match(input.system, /Saboteur/);
      assert.deepEqual(input.format.required, ["verdict", "summary", "notes", "items"]);
      assert.equal(JSON.parse(input.user).files[0].path, "file.js");
      return { result: { verdict: "CONCERNS", summary: "One retry bug.", notes: ["n"], items: [finding] } };
    },
  });
  assert.equal(review.verdict, "CONCERNS");
  assert.deepEqual(review.findings, [finding]);
  assert.deepEqual(review.notes, ["n"]);
  assert.equal(review.files.length, 1);
});

test("a malformed model result fails instead of passing as a clean review", async () => {
  await assert.rejects(runReview({ base: "b", head: "h", runGit: oneFile, call: async () => ({ result: { items: [] } }) }),
    /invalid review/);
});

test("a PR over the budget is SKIPPED with no model call; other git errors still fail", async () => {
  let calls = 0;
  const tooBig = ([command, ...args]) => {
    if (command === "diff") return args.includes("--name-only") ? "large.js\0" : "x".repeat(500_001);
    return "100644 blob abc\tlarge.js";
  };
  const review = await runReview({ base: "b", head: "h", runGit: tooBig, call: async () => { calls++; } });
  assert.equal(review.verdict, "SKIPPED");
  assert.deepEqual(review.findings, []);
  assert.equal(calls, 0);
  await assert.rejects(runReview({ base: "b", head: "h", runGit: () => { throw new Error("git failed"); } }), /git failed/);
});

test("files reviewed from the diff only are named in the notes", async () => {
  const sizes = { "large.js": 600_000, "small.js": 10 };
  const runGit = ([command, ...args]) => {
    if (command === "diff") return args.includes("--name-only") ? "large.js\0small.js\0" : "patch";
    if (command === "ls-tree") return "100644 blob abc\tfile";
    return "x".repeat(sizes[args[0].split(":")[1]]);
  };
  const review = await runReview({ base: "b", head: "h", runGit,
    call: async () => ({ result: { verdict: "CLEAN", summary: "s", notes: [], items: [] } }) });
  assert.match(review.notes.at(-1), /diff only.*`large\.js`/);
});
