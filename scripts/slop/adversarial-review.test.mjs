import { test } from "node:test";
import assert from "node:assert/strict";
import { alreadyReviewed, collectContext, main, ReviewBudgetError, reviewBody } from "./adversarial-review.mjs";

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

test("review validation rejects missing, multiple, empty and oversized results", () => {
  for (const items of [undefined, [], [{ body: "" }], [{ body: 1 }],
    [{ body: "unlabeled finding" }], [{ body: "[do] First" }, { body: "[try] Second" }],
    [{ body: "[do] " + "x".repeat(25_001) }]]) {
    assert.throws(() => reviewBody(items, "abc"), /invalid review/);
  }
  for (const label of ["do", "try", "nit"]) {
    assert.match(reviewBody([{ body: `[${label}] Finding` }], "abc"), /adversarial-review:abc/);
  }
  assert.doesNotMatch(reviewBody([{ body: "[nit] Finding" }], "abc"), /diff only/);
  assert.match(reviewBody([{ body: "[nit] Finding" }], "abc", ["big.ts"]), /diff only.*`big\.ts`/);
});

test("deduplication paginates and ignores markers posted by other users", async () => {
  const calls = [];
  const result = await alreadyReviewed("1", "abc", async (path) => {
    calls.push(path);
    if (calls.length === 1) return Array.from({ length: 100 }, () => ({
      user: { login: "contributor" }, body: "<!-- adversarial-review:abc -->",
    }));
    return [{ user: { login: "github-actions[bot]" }, body: "<!-- adversarial-review:abc -->" }];
  });
  assert.equal(result, true);
  assert.equal(calls.length, 2);
  assert.equal(await alreadyReviewed("1", "new", async () => []), false);
});

test("posts a COMMENT on the reviewed SHA and refuses stale or failed model results", async (t) => {
  const env = {
    ANTHROPIC_API_KEY: "test", GITHUB_TOKEN: "test", GITHUB_REPOSITORY: "test/repo",
    PR_NUMBER: "1", HEAD_SHA: "a".repeat(40), GITHUB_STEP_SUMMARY: "",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const scenario of ["success", "stale", "model-failure"]) {
    const posts = [];
    let reads = 0;
    const request = async (path, method, body) => {
      if (method === "POST") { posts.push(body); return {}; }
      if (path.includes("reviews?")) return [];
      reads++;
      return { state: "open", head: { sha: scenario === "stale" && reads === 2 ? "b".repeat(40) : env.HEAD_SHA } };
    };
    const call = async (input) => {
      assert.equal(input.model.id, "claude-sonnet-5-5");
      assert.equal(Object.hasOwn(input.format.properties.items, "maxItems"), false);
      assert.match(input.system, /engineering-writing/);
      if (scenario === "model-failure") throw new Error("API unavailable");
      return { items: [{ body: "[try] Verify caller assumptions." }] };
    };
    const run = main(call, request, () => [{ path: "file.js", diff: "patch" }]);
    if (scenario === "success") {
      await run;
      assert.equal(posts.length, 1);
      assert.equal(posts[0].event, "COMMENT");
      assert.equal(posts[0].commit_id, env.HEAD_SHA);
    } else {
      await assert.rejects(run, scenario === "stale" ? /stale review/ : /API unavailable/);
      assert.equal(posts.length, 0);
    }
  }
});

test("a PR over the budget skips with a notice: no model call, no review, no failure", async (t) => {
  const env = {
    ANTHROPIC_API_KEY: "test", GITHUB_TOKEN: "test", GITHUB_REPOSITORY: "test/repo",
    PR_NUMBER: "1", HEAD_SHA: "a".repeat(40), GITHUB_STEP_SUMMARY: "",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const posts = [];
  let calls = 0;
  const request = async (path, method, body) => {
    if (method === "POST") { posts.push(body); return {}; }
    if (path.includes("reviews?")) return [];
    return { state: "open", head: { sha: env.HEAD_SHA } };
  };
  await main(async () => { calls++; }, request, () => { throw new ReviewBudgetError("over budget"); });
  assert.equal(calls, 0);
  assert.equal(posts.length, 0);
  await assert.rejects(main(async () => { calls++; }, request, () => { throw new Error("git failed"); }), /git failed/);
});
