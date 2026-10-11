const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolvePull } = require("../pr-policy.cjs");

const pull = {
  number: 42, state: "open", base: { ref: "main" },
  labels: [{ name: "slop-waiver" }],
};
const context = {
  repo: { owner: "owner", repo: "repo" },
  payload: { pull_request: { number: 42 } },
};
const queued = { ...context, payload: { merge_group: {
  head_ref: "refs/heads/gh-readonly-queue/main/pr-42-abc", base_ref: "refs/heads/main",
} } };

function api(current = pull) {
  return { rest: { pulls: {
    get: async (params) => {
      assert.deepEqual(params, { ...context.repo, pull_number: 42 });
      return { data: current };
    },
  } } };
}

test("PR and queue events resolve live labels", async () => {
  assert.equal(await resolvePull(api(), context), pull);
  assert.equal(await resolvePull(api(), queued), pull);
});

test("closed or retargeted queue candidates fail closed", async () => {
  await assert.rejects(resolvePull(api({ ...pull, state: "closed" }), queued), /no longer open/);
  await assert.rejects(resolvePull(api({ ...pull, base: { ref: "other" } }), queued), /different base/);
});

test("unidentifiable events fail closed", async () => {
  await assert.rejects(resolvePull(api(), { ...context, payload: {} }), /Cannot identify/);
  await assert.rejects(resolvePull(api(), { ...context, payload: {
    merge_group: { head_ref: "refs/heads/unrecognized" },
  } }), /Cannot identify/);
});

test("API errors fail closed", async () => {
  const github = api();
  github.rest.pulls.get = async () => { throw new Error("API unavailable"); };
  await assert.rejects(resolvePull(github, context), /API unavailable/);
});
