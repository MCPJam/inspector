import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFeedback, collectFeedback, gatherFiles, headMoved, logTail, referencedPaths } from "./review-feedback.mjs";

test("log tails drop timestamps and color codes and keep the end", () => {
  const log = ["2026-10-14T10:00:00.1234567Z first", `2026-10-14T10:00:01Z ${String.fromCharCode(27)}[31mFAIL${String.fromCharCode(27)}[0m src/a.test.ts`, "last"].join("\r\n");
  assert.equal(logTail(log), "first\nFAIL src/a.test.ts\nlast");
  assert.equal(logTail(log, 1), "last");
  assert.equal(logTail("x".repeat(100), 10, 5), "xxxxx");
});

test("referenced paths are repository-relative files, not system or dependency paths", () => {
  const paths = referencedPaths([
    "FAIL mcpjam-inspector/client/src/a.test.ts > renders",
    "Error at (/home/runner/work/x.js:1:1) node_modules/vite/dist/x.js ../outside/y.ts",
    "error TS2322: sdk/src/index.ts(12,3): Type mismatch ./cli/main.ts:4",
  ]);
  assert.deepEqual(paths.sort(), ["cli/main.ts", "mcpjam-inspector/client/src/a.test.ts", "sdk/src/index.ts"]);
});

function fakeGitHub({ logError = false } = {}) {
  return async (path, options) => {
    if (path.startsWith("actions/runs/1/jobs")) {
      return { jobs: [{ id: 11, name: "Lint", conclusion: "failure" }, { id: 12, name: "Build", conclusion: "success" }] };
    }
    if (path.startsWith("actions/runs/2/jobs")) return { jobs: [] };
    if (path.startsWith("check-runs/11/annotations")) {
      return [{ path: "src/a.ts", start_line: 3, message: "no-unused-vars", annotation_level: "failure" },
        { path: ".github", start_line: 1, message: "Node 20 deprecated", annotation_level: "notice" }];
    }
    if (path === "actions/jobs/11/logs") {
      assert.equal(options.raw, true);
      if (logError) throw new Error("HTTP 410");
      return "error in src/a.ts";
    }
    throw new Error(`unexpected ${path}`);
  };
}

test("failed jobs become feedback with annotations and log tails; passed jobs are left out", async () => {
  const items = await checkFeedback(fakeGitHub(), [
    { id: 1, name: "Build and Test", file: "lint.yml" },
    { id: 2, name: "PR Size", file: "pr-size.yml" },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].source, "Build and Test / Lint");
  assert.deepEqual(items[0].annotations, [{ path: "src/a.ts", line: 3, message: "no-unused-vars", level: "failure" }]);
  assert.equal(items[0].log, "error in src/a.ts");
  assert.match(items[1].note, /large-pr/);
});

test("an expired log is reported in the item instead of failing the run", async () => {
  const [item] = await checkFeedback(fakeGitHub({ logError: true }), [{ id: 1, name: "Build and Test", file: "lint.yml" }]);
  assert.equal(item.log, "");
  assert.match(item.note, /could not be read.*410/);
});

function fakeGit(blobs) {
  return ([command, ...args]) => {
    if (command === "diff") return args.includes("--name-only") ? "src/a.ts\0" : "patch";
    if (command === "ls-tree") {
      const path = args[2].replace(":(literal)", "");
      return blobs[path] === undefined ? "" : `100644 blob ${Buffer.from(path).toString("hex")}\t${path}`;
    }
    if (command === "cat-file") return blobs[Buffer.from(args[1], "hex").toString()];
    if (command === "show") return blobs[args[0].split(":")[1]];
    throw new Error(`unexpected git ${command}`);
  };
}

test("triage gets the changed files plus the existing files the logs name", () => {
  const blobs = { "src/a.ts": "a", "src/a.test.ts": "test" };
  const { files } = gatherFiles(fakeGit(blobs), "base", "head", [
    { log: "FAIL src/a.test.ts\nsrc/missing.ts", annotations: [{ path: "src/a.ts", message: "x" }] },
  ]);
  assert.deepEqual(files.map((file) => [file.path, file.referenced === true]), [["src/a.ts", false], ["src/a.test.ts", true]]);
});

test("check phases summarise the failed workflows; the review phase passes the review through", async () => {
  const gate = { phase: "ci", mergeBase: "base", sha: "head", failedRuns: [{ id: 2, name: "PR Size", file: "pr-size.yml" }] };
  const checks = await collectFeedback({ gate, request: fakeGitHub(), runGit: fakeGit({ "src/a.ts": "a" }) });
  assert.equal(checks.summary, "Failed: PR Size.");
  assert.equal(checks.items.length, 1);

  const review = await collectFeedback({
    gate: { ...gate, phase: "review" }, runGit: fakeGit({ "src/a.ts": "a" }),
    call: async () => ({ result: { verdict: "CLEAN", summary: "s", notes: [], items: [{ title: "nit" }] } }),
  });
  assert.equal(review.verdict, "CLEAN");
  assert.deepEqual(review.items, [{ source: "Adversarial review", title: "nit" }]);
});

test("a run whose PR moved on or closed stops before any Claude call", async () => {
  const gate = { pr: 7, sha: "a".repeat(40) };
  const pr = (sha, state = "open") => async (path) => {
    assert.equal(path, "pulls/7");
    return { state, head: { sha } };
  };
  assert.equal(await headMoved(pr(gate.sha), gate), false);
  assert.equal(await headMoved(pr("b".repeat(40)), gate), true);
  assert.equal(await headMoved(pr(gate.sha, "closed"), gate), true);
});
