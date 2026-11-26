import assert from "node:assert/strict";
import { test } from "node:test";
import { flagFromEvent, isSecurityFlag } from "./security-flag.mjs";

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
