import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findReleaseEvidence,
  isTrustedEvidenceRun,
  releaseEvidenceName,
} from "./release-evidence.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PACKS = "1.0.7/1.0.3/1.0.6/";
const NAME = releaseEvidenceName({ digest: DIGEST, packs: PACKS });
const REPO = "MCPJam/inspector";

const run = (id, overrides = {}) => ({
  id,
  path: ".github/workflows/local-harness-release-evidence.yml",
  event: "push",
  head_branch: "main",
  status: "completed",
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  ...overrides,
});
const marker = (runId, createdAt, overrides = {}) => ({
  name: NAME,
  expired: false,
  created_at: createdAt,
  workflow_run: { id: runId },
  ...overrides,
});
const evidence = (expired = false) => [{ name: "conformance-evidence-codex-linux-x64-1.0.3", expired }];

/** Enough of Octokit for the lookup, over mutable state. */
function fakeGitHub(state) {
  return {
    paginate: async (method, params) => (await method(params)).data.items,
    rest: {
      actions: {
        listArtifactsForRepo: async ({ name }) => ({
          data: { items: state.markers.filter((artifact) => artifact.name === name) },
        }),
        getWorkflowRun: async ({ run_id }) => ({ data: state.runs[run_id] }),
        listWorkflowRunArtifacts: async ({ run_id }) => ({ data: { items: state.evidence[run_id] ?? [] } }),
        listWorkflowRuns: async ({ workflow_id, head_sha }) => ({
          data: {
            workflow_runs: (state.active ?? []).filter(
              (candidate) => workflow_id === "local-harness-release-evidence.yml" && candidate.head_sha === head_sha,
            ),
          },
        }),
      },
    },
  };
}

test("names evidence by the inputs digest and the packs, and nothing else", () => {
  assert.equal(releaseEvidenceName({ digest: DIGEST, packs: PACKS }), NAME);
  assert.match(NAME, /^local-harness-release-evidence-[0-9a-f]{40}$/);
  assert.notEqual(releaseEvidenceName({ digest: `sha256:${"b".repeat(64)}`, packs: PACKS }), NAME);
  assert.notEqual(releaseEvidenceName({ digest: DIGEST, packs: "1.0.8/1.0.3/1.0.7/" }), NAME);
  assert.throws(() => releaseEvidenceName({ digest: "abc", packs: PACKS }), /not a conformance inputs digest/);
  assert.throws(() => releaseEvidenceName({ digest: DIGEST, packs: "" }), /packs/);
});

test("trusts only the evidence run and releases, started from this repo's main by a push or a dispatch", () => {
  assert.equal(isTrustedEvidenceRun(run(1), REPO), true);
  assert.equal(isTrustedEvidenceRun(run(1, { path: ".github/workflows/release.yml", event: "workflow_dispatch" }), REPO), true);
  assert.equal(isTrustedEvidenceRun(run(1, { event: "pull_request" }), REPO), false);
  assert.equal(isTrustedEvidenceRun(run(1, { head_repository: { full_name: "someone/inspector" } }), REPO), false);
  assert.equal(isTrustedEvidenceRun(run(1, { head_branch: "feature" }), REPO), false);
  assert.equal(isTrustedEvidenceRun(run(1, { path: ".github/workflows/test.yml" }), REPO), false);
});

test("takes the newest trusted run whose evidence has not expired", async () => {
  const state = {
    markers: [marker(10, "2026-11-10T00:00:00Z"), marker(11, "2026-11-11T00:00:00Z"), marker(12, "2026-11-12T00:00:00Z")],
    runs: {
      10: run(10),
      11: run(11),
      12: run(12, { event: "pull_request" }),
    },
    evidence: { 10: evidence(), 11: evidence(true), 12: evidence() },
  };
  const found = await findReleaseEvidence({ github: fakeGitHub(state), owner: "MCPJam", repo: "inspector", name: NAME });
  assert.equal(found.runId, 10);
});

test("finds nothing when no trusted run left a marker", async () => {
  const state = { markers: [], runs: {}, evidence: {} };
  const found = await findReleaseEvidence({ github: fakeGitHub(state), owner: "MCPJam", repo: "inspector", name: NAME });
  assert.equal(found.runId, null);
});

test("waits for the evidence run producing this commit's evidence, then uses it", async () => {
  const state = { markers: [], runs: { 20: run(20) }, evidence: { 20: evidence() }, active: [{ id: 20, status: "in_progress", head_sha: "abc" }] };
  let slept = 0;
  const found = await findReleaseEvidence({
    github: fakeGitHub(state),
    owner: "MCPJam",
    repo: "inspector",
    name: NAME,
    sha: "abc",
    timeoutMs: 60_000,
    sleep: async () => {
      slept += 1;
      state.markers = [marker(20, "2026-11-12T00:00:00Z")];
      state.active = [];
    },
  });
  assert.equal(slept, 1);
  assert.equal(found.runId, 20);
});

test("stops waiting at the deadline and lets the release run the gate", async () => {
  const state = { markers: [], runs: {}, evidence: {}, active: [{ id: 21, status: "queued", head_sha: "abc" }] };
  let clock = 0;
  const found = await findReleaseEvidence({
    github: fakeGitHub(state),
    owner: "MCPJam",
    repo: "inspector",
    name: NAME,
    sha: "abc",
    timeoutMs: 90_000,
    pollMs: 30_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(found.runId, null);
  assert.match(found.reason, /still queued/);
});
