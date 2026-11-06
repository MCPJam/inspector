import { test } from "node:test";
import assert from "node:assert/strict";
import { SUMMARY_MARKER, decodeState, encodeState } from "./review-common.mjs";
import { toDraft } from "./review-draft.mjs";
import { defaultOwners, handoff, pickReviewer } from "./review-handoff.mjs";

const SHA = "a".repeat(40);
const LOGIN = "mcpjam-bot[bot]";

/** A PR and its comments, reviewer requests and assignees, as the REST and GraphQL calls see them. */
function fakeGitHub({ pr = {}, requested = [], state } = {}) {
  const pull = {
    number: 7, node_id: "PR_7", state: "open", draft: true, head: { sha: SHA, repo: { full_name: "o/r" } },
    user: { login: "author" }, labels: [], assignees: [], ...pr,
  };
  const comments = state ? [{ id: 1, user: { login: LOGIN, type: "Bot" }, body: `${SUMMARY_MARKER}\n${encodeState(state)}` }] : [];
  const calls = [];
  let reviewers = [...requested];
  const request = async (path, { method = "GET", body } = {}) => {
    calls.push([method, path, body]);
    if (path === "pulls/7") return pull;
    if (path === "pulls/7/requested_reviewers" && method === "GET") return { users: reviewers.map((login) => ({ login })), teams: [] };
    if (path === "pulls/7/requested_reviewers" && method === "POST") { reviewers.push(...body.reviewers); return {}; }
    if (path === "pulls/7/requested_reviewers" && method === "DELETE") { reviewers = reviewers.filter((login) => !body.reviewers.includes(login)); return {}; }
    if (path === "issues/7/assignees") { pull.assignees.push(...body.assignees.map((login) => ({ login }))); return {}; }
    if (path.startsWith("issues/7/comments") && method === "GET") return comments;
    if (path === "issues/7/comments") { comments.push({ id: 2, user: { login: LOGIN, type: "Bot" }, body: body.body }); return {}; }
    if (path === "issues/comments/1") { comments[0].body = body.body; return {}; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const mutations = [];
  const graphql = async (query) => {
    mutations.push(query.match(/(markPullRequestReadyForReview|convertPullRequestToDraft)/)[1]);
    if (/ReadyForReview/.test(query)) { pull.draft = false; reviewers.push("owner-a", "owner-b"); }
    if (/ToDraft/.test(query)) pull.draft = true;
    return {};
  };
  return { request, graphql, pull, comments, calls, mutations, reviewers: () => reviewers };
}

const gate = { pr: 7, sha: SHA, mode: "on", author: "author" };

test("the reviewer is never the author or a bot, and the PR number spreads the choice", () => {
  assert.equal(pickReviewer(["author", "ci[bot]"], { author: "author", pr: 1 }), null);
  assert.equal(pickReviewer(["b", "a", "author"], { author: "author", pr: 0 }), "a");
  assert.equal(pickReviewer(["b", "a"], { author: "x", pr: 1 }), "b");
});

test("CODEOWNERS' catch-all owners are the fallback, teams left out", () => {
  const file = "# comment\n* @old\n/src/ @src-owner\n* @one @org/team @two # trailing\n";
  assert.deepEqual(defaultOwners(file), ["one", "two"]);
  assert.deepEqual(defaultOwners("/src/ @x\n"), []);
});

test("hand-off marks the draft ready, re-requests held reviewers, assigns one owner and says so", async () => {
  const github = fakeGitHub({ state: { heldReviewers: ["asked-by-author"], status: "**Done**" } });
  const result = await handoff({ gate, request: github.request, graphql: github.graphql, login: LOGIN, codeowners: "", polls: 1 });
  assert.deepEqual(github.mutations, ["markPullRequestReadyForReview"]);
  assert.equal(result.reviewer, "owner-b");
  assert.deepEqual(github.pull.assignees, [{ login: "owner-b" }]);
  assert.ok(github.reviewers().includes("asked-by-author"));
  const state = decodeState(github.comments[0].body);
  assert.deepEqual([state.heldReviewers, state.handoff.reviewer], [[], "owner-b"]);
  assert.match(github.comments[0].body, /Ready for review\.\*\* [\s\S]*assigned @owner-b/);
});

test("with no code owner requested, hand-off requests and assigns a catch-all owner", async () => {
  const github = fakeGitHub();
  github.graphql = async () => { github.pull.draft = false; return {}; };
  const result = await handoff({ gate, request: github.request, graphql: github.graphql, login: LOGIN, codeowners: "* @fallback", polls: 1 });
  assert.equal(result.reviewer, "fallback");
  assert.ok(github.reviewers().includes("fallback"));
});

test("hand-off does nothing in suggest mode, on a moved head, or on a PR already ready and assigned", async () => {
  for (const [input, pattern] of [
    [{ gate: { ...gate, mode: "suggest" } }, /only runs when the pipeline is on/],
    [{ pr: { head: { sha: "b".repeat(40) } } }, /moved on/],
    [{ pr: { draft: false, assignees: [{ login: "x" }] } }, /already ready and assigned/],
  ]) {
    const github = fakeGitHub({ pr: input.pr });
    const result = await handoff({ gate: input.gate ?? gate, request: github.request, graphql: github.graphql, login: LOGIN, codeowners: "", polls: 1 });
    assert.match(result.skipped, pattern);
    assert.deepEqual(github.mutations, []);
  }
});

test("the wip label keeps the PR in draft and the comment says how to release it", async () => {
  const github = fakeGitHub({ pr: { labels: [{ name: "wip" }] }, state: { status: "**Done**" } });
  const result = await handoff({ gate, request: github.request, graphql: github.graphql, login: LOGIN, codeowners: "", polls: 1 });
  assert.match(result.skipped, /wip/);
  assert.deepEqual(github.mutations, []);
  assert.match(github.comments[0].body, /Kept as a draft because of the `wip` label/);
});

test("a PR opened ready goes back to draft, its review requests come off and are remembered", async () => {
  const github = fakeGitHub({ pr: { draft: false }, requested: ["owner-a", "picked-by-author"] });
  const result = await toDraft({ number: 7, request: github.request, graphql: github.graphql, login: LOGIN, repo: "o/r", setting: "on", settleMs: 0 });
  assert.deepEqual([result.converted, result.removed], [true, 2]);
  assert.deepEqual(github.mutations, ["convertPullRequestToDraft"]);
  assert.deepEqual(github.reviewers(), []);
  const state = decodeState(github.comments[0].body);
  assert.deepEqual(state.heldReviewers, ["owner-a", "picked-by-author"]);
  assert.match(github.comments[0].body, /went back to draft/);
});

test("the draft step leaves drafts, forks and PRs outside on mode alone", async () => {
  for (const [pr, setting] of [[{ draft: true }, "on"], [{ draft: false, head: { sha: SHA, repo: { full_name: "fork/r" } } }, "on"],
    [{ draft: false }, "suggest"], [{ draft: false }, undefined]]) {
    const github = fakeGitHub({ pr });
    const result = await toDraft({ number: 7, request: github.request, graphql: github.graphql, login: LOGIN, repo: "o/r", setting, settleMs: 0 });
    assert.ok(result.skipped);
    assert.deepEqual(github.mutations, []);
  }
  const labelled = fakeGitHub({ pr: { draft: false, labels: [{ name: "review-pipeline" }] } });
  const result = await toDraft({ number: 7, request: labelled.request, graphql: labelled.graphql, login: LOGIN, repo: "o/r", setting: undefined, settleMs: 0 });
  assert.equal(result.converted, true);
});
