import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, itemMarker, phaseMarker } from "./review-common.mjs";
import { commentBody, hunkRanges, publish } from "./review-publish.mjs";

const identity = { name: "bot[bot]", email: "1+bot[bot]@users.noreply.github.com" };
const lines = (count, label = "line") => Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join("\n") + "\n";

/** A remote, and a clone with a base commit and one PR commit that changes lines 20-21 of a.ts. */
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "review-publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(dir, "remote.git")]);
  const work = join(dir, "work");
  execFileSync("git", ["clone", "-q", join(dir, "remote.git"), work], { stdio: "ignore" });
  const git = gitIn(work);
  const commit = (message) => {
    git(["add", "-A"]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  writeFileSync(join(work, "a.ts"), lines(40));
  const base = commit("base");
  writeFileSync(join(work, "a.ts"), lines(40).replace("line 20\nline 21\n", "changed 20\nchanged 21\n"));
  const head = commit("pr");
  git(["push", "-q", "origin", "HEAD:refs/heads/feature"]);
  return { git, base, head, remote: gitIn(join(dir, "remote.git")), work };
}

function fakeGitHub({ head, postError, prior = [] }) {
  const posts = [];
  const request = async (path, options = {}) => {
    if (options.method === "POST") {
      if (postError && posts.length === 0) {
        posts.push({ rejected: options.body });
        throw new Error(postError);
      }
      posts.push(options.body);
      return {};
    }
    if (path.startsWith("pulls/7/reviews")) return prior;
    if (path.startsWith("pulls/7/comments")) return [];
    if (path === "pulls/7") return { state: "open", head: { sha: head } };
    throw new Error(`unexpected ${path}`);
  };
  return { request, posts };
}

const item = (fields) => ({
  category: "suggest", title: "t", path: "a.ts", find: "changed 20", replace: "fixed 20", why: "w",
  options: [], commit: "", downgraded: "", ...fields,
});

function run(t, { items, postError, prior, headOverride } = {}) {
  const ctx = repo(t);
  const gate = { pr: 7, sha: ctx.head, headRef: "feature", phase: "review", mergeBase: ctx.base };
  const github = fakeGitHub({ head: headOverride ?? ctx.head, postError, prior });
  const pushes = [];
  const push = (ref) => { pushes.push(ref); ctx.git(["push", "-q", "origin", `HEAD:refs/heads/${ref}`]); };
  const result = publish({
    gate, triage: { summary: "Summary.", verdict: "CONCERNS", notes: ["an assumption"], items },
    request: github.request, runGit: ctx.git, push, identity, commitUrl: (sha) => `https://x/${sha}`,
  });
  return { ctx, gate, github, pushes, result };
}

test("hunk ranges cover the right-hand lines GitHub shows, context included", () => {
  assert.deepEqual(hunkRanges("@@ -17,8 +17,9 @@ x\n@@ -50 +51,0 @@\n@@ -60 +60 @@"), [{ start: 17, end: 25 }, { start: 60, end: 60 }]);
});

test("all autofixes go into one bot commit, pushed once, and the review lands on the new head", async (t) => {
  const items = [
    item({ category: "autofix", find: "changed 21", replace: "fixed 21", commit: "Fix line 21" }),
    item({ category: "autofix", find: "line 2", replace: "line two", commit: "Fix line 2" }),
    item({ category: "suggest", find: "changed 20", replace: "better 20" }),
    item({ category: "discuss", find: "line 35", replace: "", options: ["A", "B"] }),
  ];
  const { ctx, github, pushes, result } = run(t, { items });
  const outcome = await result;
  assert.deepEqual(pushes, ["feature"]);
  const log = ctx.remote(["log", "--format=%an|%B%x00", `${ctx.head}..feature`]).split("\0").map((entry) => entry.trim()).filter(Boolean);
  assert.equal(log.length, 1);
  assert.match(log[0], /^bot\[bot\]\|Apply 2 review autofixes\n\n- Fix line 21\n- Fix line 2\n\nReview-Pipeline-Autofix: review$/);
  assert.match(ctx.remote(["show", "feature:a.ts"]), /line two\n[\s\S]*fixed 21/);

  const [review] = github.posts;
  assert.equal(review.commit_id, ctx.git(["rev-parse", "HEAD"]).trim());
  assert.equal(review.event, "COMMENT");
  assert.equal(review.comments.length, 1, "only the suggestion is on a changed line");
  assert.deepEqual([review.comments[0].line, review.comments[0].side], [20, "RIGHT"]);
  assert.match(review.comments[0].body, /```suggestion\nbetter 20\n```/);
  assert.match(review.body, /Autofixed\*\* 2 items in \[`[0-9a-f]{7}`\]/);
  assert.match(review.body, /Not on a changed line[\s\S]*Needs a decision[\s\S]*1\. A\n2\. B/);
  assert.match(review.body, /an assumption/);
  assert.ok(review.body.endsWith(phaseMarker("review", ctx.head)));
  assert.equal(outcome.autofixed, 2);
});

test("multi-line suggestions span start_line to line; nothing is pushed without autofixes", async (t) => {
  const { github, pushes, result } = run(t, { items: [item({ find: "changed 20\nchanged 21", replace: "one line" })] });
  await result;
  assert.deepEqual(pushes, []);
  const [comment] = github.posts[0].comments;
  assert.deepEqual([comment.start_line, comment.line], [20, 21]);
});

test("two autofixes to the same file both land, and a single fix keeps its own subject", async (t) => {
  const pair = run(t, { items: [
    item({ category: "autofix", find: "changed 20", replace: "fixed 20", commit: "Fix 20" }),
    item({ category: "autofix", find: "changed 21", replace: "fixed 21", commit: "Fix 21" }),
  ] });
  await pair.result;
  assert.match(pair.ctx.remote(["show", "feature:a.ts"]), /fixed 20\nfixed 21/);
  const single = run(t, { items: [item({ category: "autofix", commit: "Fix 20" })] });
  await single.result;
  assert.equal(single.ctx.remote(["log", "-1", "--format=%s", "feature"]).trim(), "Fix 20");
});

test("an autofix that no longer applies after an earlier one is posted as a suggestion", async (t) => {
  const items = [
    item({ category: "autofix", find: "changed 20\nchanged 21", replace: "merged", commit: "Merge lines" }),
    item({ category: "autofix", find: "changed 21", replace: "x", commit: "Fix 21" }),
  ];
  const { github, result } = run(t, { items });
  assert.equal((await result).autofixed, 1);
  assert.match(github.posts[0].body, /earlier fix changed these lines/);
});

test("items already posted by the bot on an earlier push are not repeated", async (t) => {
  const repeated = item({});
  const prior = [{ user: { type: "Bot" }, body: itemMarker(repeated) }];
  const { github, result } = run(t, { items: [repeated], prior });
  await result;
  assert.equal(github.posts[0].comments.length, 0);
});

test("a 422 on inline comments posts every item in the body instead", async (t) => {
  const { github, result } = run(t, { items: [item({})], postError: "GitHub POST pulls/7/reviews: HTTP 422" });
  await result;
  assert.equal(github.posts.length, 2);
  assert.equal(github.posts[1].comments, undefined);
  assert.match(github.posts[1].body, /```diff\n-changed 20\n\+fixed 20\n```/);
});

test("a PR that moved during the run gets no commits and no review", async (t) => {
  const { github, pushes, result } = run(t, { items: [item({ category: "autofix", commit: "x" })], headOverride: "f".repeat(40) });
  assert.match((await result).skipped, /changed during the run/);
  assert.deepEqual(pushes, []);
  assert.equal(github.posts.length, 0);
});

test("autofix edits go through git objects, so a symlink in the PR cannot redirect a write", async (t) => {
  const ctx = repo(t);
  const outside = join(ctx.work, "..", "outside.txt");
  writeFileSync(outside, "secret\n");
  symlinkSync(outside, join(ctx.work, "link.txt"));
  ctx.git(["add", "link.txt"]);
  ctx.git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "link"]);
  const head = ctx.git(["rev-parse", "HEAD"]).trim();
  const github = fakeGitHub({ head });
  const outcome = await publish({
    gate: { pr: 7, sha: head, headRef: "feature", phase: "ci", mergeBase: ctx.base },
    triage: { summary: "s", items: [item({ category: "autofix", path: "link.txt", find: "secret", replace: "pwned", commit: "x" })] },
    request: github.request, runGit: ctx.git, push: () => {}, identity, commitUrl: String,
  });
  assert.equal(outcome.autofixed, 0);
  assert.equal(readFileSync(outside, "utf8"), "secret\n");
});

test("suggestion fences grow past backticks in the replacement", () => {
  assert.match(commentBody(item({ replace: "const s = ```;" })), /````suggestion\nconst s = ```;\n````/);
});
