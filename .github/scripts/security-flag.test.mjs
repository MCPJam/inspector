import assert from "node:assert/strict";
import { test } from "node:test";
import { flagFromEvent, isSecurityFlag, recordFlag } from "./security-flag.mjs";

test("matches named security problems and the /security command", () => {
  for (const text of [
    "Passing user input to new Function() here is remote code execution.",
    "Possible SSRF if the URL comes from the user",
    "/security please look at the token handling",
    "This is a security concern for hosted mode",
    "Looks like an auth bypass when the header is missing",
  ]) {
    assert.equal(isSecurityFlag(text), true, text);
  }
});

test("ignores ordinary review talk, eval vocabulary and quoted text", () => {
  for (const text of [
    "Run the evals again before merging",
    "nit: rename this variable",
    "Add security headers to the docs page?",
    "> Possible SSRF here\n\nThanks, fixed.",
    null,
  ]) {
    assert.equal(isSecurityFlag(text), false, String(text));
  }
});

const pr = { number: 12, html_url: "https://x/pull/12" };
const note = (login, type, body) => ({ user: { login, type }, body, html_url: "https://x/c/1" });

test("reads comments, reviews and the security label", () => {
  const flagged = note("dana", "User", "XSS in the widget title");
  assert.deepEqual(flagFromEvent("issue_comment", { issue: { ...pr, pull_request: {} }, comment: flagged }), {
    pr: { ...pr, pull_request: {} },
    url: "https://x/c/1",
    by: "dana",
  });
  assert.equal(flagFromEvent("pull_request_review", { pull_request: pr, review: flagged }).by, "dana");
  const label = flagFromEvent("pull_request_target", { pull_request: pr, label: { name: "security" }, sender: { login: "ed" } });
  assert.deepEqual(label, { pr, url: pr.html_url, by: "ed" });
});

test("skips bots, issues that are not PRs, and other labels", () => {
  const bot = note("coderabbitai[bot]", "Bot", "Potential SSRF");
  assert.equal(flagFromEvent("pull_request_review_comment", { pull_request: pr, comment: bot }), null);
  const human = note("dana", "User", "Potential SSRF");
  assert.equal(flagFromEvent("issue_comment", { issue: { number: 3 }, comment: human }), null);
  assert.equal(flagFromEvent("pull_request_target", { pull_request: pr, label: { name: "bug" }, sender: {} }), null);
});

// In-memory issues and comments; `list` returns everything, as the paginated client does.
function fakeGitHub(issues = []) {
  const comments = [];
  let next = 100;
  const gh = {
    issues,
    comments,
    list: async (path) => {
      if (path.startsWith("/issues?")) return issues.filter((i) => i.state === "open");
      const n = Number(path.match(/^\/issues\/(\d+)\/comments$/)[1]);
      return comments.filter((c) => c.on === n);
    },
    post: async (path, body) => {
      if (path === "/issues") {
        const issue = { number: next++, state: "open", ...body };
        issues.push(issue);
        return issue;
      }
      comments.push({ on: Number(path.split("/")[2]), body: body.body });
      return {};
    },
    patch: async (path, body) => Object.assign(issues.find((i) => i.number === Number(path.split("/")[2])), body),
  };
  return gh;
}

const flag = (by) => ({ pr: { number: 12 }, url: `https://x/c/${by}`, by });
const acks = (gh) => gh.comments.filter((c) => c.on === 12);

test("opens one issue for the first flag and adds later flags to it", async () => {
  const gh = fakeGitHub();
  await recordFlag(flag("dana"), gh, "sec");
  await recordFlag(flag("ed"), gh, "sec");
  assert.equal(gh.issues.length, 1);
  assert.deepEqual(gh.issues[0].assignees, ["sec"]);
  assert.deepEqual(
    gh.comments.filter((c) => c.on === 100).map((c) => c.body),
    ["Another flag from @ed: https://x/c/ed"],
  );
  assert.deepEqual(acks(gh).map((c) => c.body), ["Logged for security triage in #100, owned by sec."]);
});

test("two flags that both create an issue leave one open issue holding both", async () => {
  const gh = fakeGitHub();
  // Hold each run's first lookup until both have looked, so neither sees the other's issue.
  const list = gh.list;
  let release;
  const bothLooked = new Promise((resolve) => (release = resolve));
  let lookups = 0;
  gh.list = async (path) => {
    const result = await list(path);
    if (path.startsWith("/issues?") && ++lookups <= 2) {
      if (lookups === 2) release();
      await bothLooked;
    }
    return result;
  };
  await Promise.all([recordFlag(flag("dana"), gh, "sec"), recordFlag(flag("ed"), gh, "sec")]);
  const open = gh.issues.filter((i) => i.state === "open");
  assert.deepEqual(open.map((i) => i.number), [100]);
  assert.ok(gh.comments.some((c) => c.on === 101 && c.body === "Duplicate of #100."));
  assert.ok(gh.comments.some((c) => c.on === 100 && c.body.startsWith("Another flag from @")));
  assert.ok(acks(gh).length >= 1);
  assert.ok(acks(gh).every((c) => c.body.startsWith("Logged for security triage in #100")));
});

test("a rerun restores a missing PR reply and does not repeat one that exists", async () => {
  const gh = fakeGitHub([{ number: 7, state: "open", title: "Security flag on PR #12" }]);
  await recordFlag(flag("dana"), gh, "");
  assert.deepEqual(acks(gh).map((c) => c.body), ["Logged for security triage in #7."]);
  await recordFlag(flag("dana"), gh, "");
  assert.equal(acks(gh).length, 1);
});
