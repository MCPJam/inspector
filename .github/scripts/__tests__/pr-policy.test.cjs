const assert = require("node:assert/strict");
const { test } = require("node:test");
const { approvedReviewers, enforceApprovals, resolvePull } = require("../pr-policy.cjs");

const pull = {
  number: 42, state: "open", base: { ref: "main" }, head: { sha: "current" },
  user: { login: "author" }, labels: [{ name: "large-pr" }],
};
const context = { repo: { owner: "owner", repo: "repo" }, payload: { pull_request: { number: 42 } } };
const review = (id, login, state = "APPROVED", extra = {}) => ({
  id, user: { login, type: "User" }, state, commit_id: "current", ...extra,
});

function api(reviews, permissions = {}, current = pull) {
  return {
    rest: {
      pulls: {
        get: async ({ pull_number }) => {
          assert.equal(pull_number, 42);
          return { data: current };
        },
        listReviews: "reviews",
      },
      repos: {
        getCollaboratorPermissionLevel: async ({ username }) => ({
          data: { permission: permissions[username] || "write" },
        }),
      },
    },
    paginate: async (endpoint, params) => {
      assert.equal(endpoint, "reviews");
      assert.equal(params.pull_number, 42);
      assert.equal(params.per_page, 100);
      return reviews;
    },
  };
}

test("counts distinct human reviewers on the current head, excluding the author", () => {
  assert.deepEqual(approvedReviewers([
    review(1, "alice"), review(2, "alice"), review(3, "author"),
    review(4, "stale", "APPROVED", { commit_id: "old" }),
    review(5, "bot", "APPROVED", { user: { login: "bot", type: "Bot" } }),
    review(6, "deleted", "APPROVED", { user: null }), review(7, "bob"),
  ], pull), ["alice", "bob"]);
});

test("latest decisive review wins; comments do not erase an approval", () => {
  assert.deepEqual(approvedReviewers([
    review(6, "carol"), review(1, "alice"), review(2, "alice", "DISMISSED"),
    review(3, "bob"), review(4, "bob", "CHANGES_REQUESTED"),
    review(5, "carol", "CHANGES_REQUESTED"), review(7, "carol", "COMMENTED"),
  ], pull), ["carol"]);
});

test("large PRs fail with zero, one, duplicate, or read-only approvals", async () => {
  for (const reviews of [[], [review(1, "alice")], [review(1, "alice"), review(2, "alice")]]) {
    await assert.rejects(enforceApprovals(api(reviews), context), /two human approvals/);
  }
  await assert.rejects(enforceApprovals(api([review(1, "alice"), review(2, "bob")], { bob: "read" }), context), /found 1/);
});

test("large PRs pass with two authorized human reviewers", async () => {
  await enforceApprovals(api([review(1, "alice"), review(2, "bob")], { alice: "maintain", bob: "admin" }), context);
});

test("ordinary PRs do not need an extra approval", async () => {
  await enforceApprovals(api([], {}, { ...pull, labels: [] }), context);
});

test("queue checks fetch current PR metadata and enforce approvals", async () => {
  const queued = { ...context, payload: { merge_group: {
    head_ref: "refs/heads/gh-readonly-queue/main/pr-42-abc", base_ref: "refs/heads/main",
  } } };
  assert.equal(await resolvePull(api([]), queued), pull);
  await assert.rejects(enforceApprovals(api([]), queued), /found 0/);
  await assert.rejects(resolvePull(api([], {}, { ...pull, state: "closed" }), queued), /no longer open/);
  await assert.rejects(resolvePull(api([], {}, { ...pull, base: { ref: "other" } }), queued), /different base/);
  await assert.rejects(resolvePull(api([]), { ...context, payload: {} }), /Cannot identify/);
});

test("API errors fail closed", async () => {
  const github = api([]);
  github.paginate = async () => { throw new Error("API unavailable"); };
  await assert.rejects(enforceApprovals(github, context), /API unavailable/);
});
