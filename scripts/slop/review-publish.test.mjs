import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUMMARY_MARKER, decodeState, gitIn, phaseMarker } from "./review-common.mjs";
import { publish } from "./review-publish.mjs";

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

/** A PR's issue comments, as the bot's REST calls see and change them. */
export function fakeGitHub({ head, comments = [] }) {
  const writes = [];
  const request = async (path, options = {}) => {
    if (options.method === "POST" && path === "issues/7/comments") {
      const comment = { id: comments.length + 1, user: { login: identity.name, type: "Bot" }, body: options.body.body };
      comments.push(comment);
      writes.push(comment.body);
      return comment;
    }
    if (options.method === "PATCH") {
      const comment = comments.find((entry) => `issues/comments/${entry.id}` === path);
      comment.body = options.body.body;
      writes.push(comment.body);
      return comment;
    }
    if (path.startsWith("issues/7/comments")) return comments;
    if (path === "pulls/7") return { state: "open", head: { sha: head } };
    throw new Error(`unexpected ${options.method ?? "GET"} ${path}`);
  };
  return { request, comments, writes };
}

const item = (fields) => ({
  category: "suggest", title: "t", path: "a.ts", find: "changed 20", replace: "fixed 20", why: "w",
  options: [], commit: "", downgraded: "", ...fields,
});

const decision = { decision: "Store retries on the run", why: "Not stated", alternative: "A separate table", risk: "A migration later" };

function run(t, { items, comments, headOverride, phase = "review" } = {}) {
  const ctx = repo(t);
  const gate = { pr: 7, sha: ctx.head, headRef: "feature", phase, mergeBase: ctx.base };
  const github = fakeGitHub({ head: headOverride ?? ctx.head, comments });
  const pushes = [];
  const push = (ref) => { pushes.push(ref); ctx.git(["push", "-q", "origin", `HEAD:refs/heads/${ref}`]); };
  const result = publish({
    gate, triage: { summary: "Summary.", verdict: "CONCERNS", notes: ["an assumption"], decisions: [decision], items },
    request: github.request, runGit: ctx.git, push, identity, commitUrl: (sha) => `https://x/${sha}`,
  });
  return { ctx, gate, github, pushes, result };
}

test("all autofixes go into one bot commit, pushed once, and the rest go in the one summary comment", async (t) => {
  const items = [
    item({ category: "autofix", find: "changed 21", replace: "fixed 21", commit: "Fix line 21" }),
    item({ category: "autofix", find: "line 2", replace: "line two", commit: "Fix line 2" }),
    item({ category: "suggest", find: "changed 20", replace: "better 20" }),
    item({ category: "discuss", title: "Pick a limit", find: "line 35", replace: "", options: ["A", "B"] }),
  ];
  const { ctx, github, pushes, result } = run(t, { items });
  const outcome = await result;
  assert.deepEqual(pushes, ["feature"]);
  assert.equal(outcome.pushed, true);
  const log = ctx.remote(["log", "--format=%an|%B%x00", `${ctx.head}..feature`]).split("\0").map((entry) => entry.trim()).filter(Boolean);
  assert.equal(log.length, 1);
  assert.match(log[0], /^bot\[bot\]\|Apply 2 review autofixes\n\n- Fix line 21\n- Fix line 2\n\nReview-Pipeline-Autofix: review$/);
  assert.match(ctx.remote(["show", "feature:a.ts"]), /line two\n[\s\S]*fixed 21/);

  assert.equal(github.comments.length, 1, "one comment, nothing inline");
  const [{ body }] = github.comments;
  assert.ok(body.startsWith(SUMMARY_MARKER));
  assert.match(body, /\*\*Working\.\*\* Pushed 2 fixes for Adversarial review/);
  assert.match(body, /Key decisions in this PR[\s\S]*Store retries on the run[\s\S]*Risk if wrong: A migration later/);
  assert.match(body, /Needs your call \(2\)[\s\S]*```diff\n-changed 20\n\+better 20\n```[\s\S]*Pick a limit[\s\S]*1\. A\n2\. B/);
  assert.match(body, /Fixed by the bot \(2\)/);
  assert.match(body, /an assumption/);
  assert.deepEqual(decodeState(body).triaged, [phaseMarker("review", ctx.head)]);
});

test("a run that pushes nothing says the bot is done, and the next run edits the same comment", async (t) => {
  const first = run(t, { items: [item({})] });
  const outcome = await first.result;
  assert.equal(outcome.pushed, false);
  assert.match(first.github.comments[0].body, /\*\*Done with `[0-9a-f]{7}`\.\*\*[\s\S]*1 item below needs a person/);

  const again = run(t, { items: [], comments: first.github.comments });
  await again.result;
  assert.equal(again.github.comments.length, 1);
  assert.doesNotMatch(again.github.comments[0].body, /Needs your call/, "the review's items are replaced by its next run");
});

test("triaging a later phase clears the earlier phase's items; a person's copy of the marker is ignored", async (t) => {
  const ci = run(t, { items: [item({ title: "Flaky test" })], phase: "ci" });
  await ci.result;
  assert.match(ci.github.comments[0].body, /Flaky test/);
  ci.github.comments.unshift({ id: 99, user: { login: "someone", type: "User" }, body: `${SUMMARY_MARKER}\nfake` });
  const review = run(t, { items: [], comments: ci.github.comments });
  await review.result;
  const mine = review.github.comments.find((comment) => comment.user.login === identity.name);
  assert.doesNotMatch(mine.body, /Flaky test/);
  assert.equal(review.github.comments.find((comment) => comment.id === 99).body, `${SUMMARY_MARKER}\nfake`);
});

test("an autofix that no longer applies after an earlier one is listed for a person", async (t) => {
  const items = [
    item({ category: "autofix", find: "changed 20\nchanged 21", replace: "merged", commit: "Merge lines" }),
    item({ category: "autofix", find: "changed 21", replace: "x", commit: "Fix 21" }),
  ];
  const { github, result } = run(t, { items });
  assert.equal((await result).autofixed, 1);
  assert.match(github.comments[0].body, /earlier fix changed these lines/);
});

test("a PR that moved during the run gets no commits and no comment", async (t) => {
  const { github, pushes, result } = run(t, { items: [item({ category: "autofix", commit: "x" })], headOverride: "f".repeat(40) });
  assert.match((await result).skipped, /changed during the run/);
  assert.deepEqual(pushes, []);
  assert.equal(github.comments.length, 0);
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

