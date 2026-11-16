import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveReleaseStatus,
  releaseAction,
  typicalReleaseMinutes
} from "../src/lib/release-status.ts";

const run = (over = {}) => ({
  id: 1,
  name: "Release",
  headSha: "abc",
  headBranch: "main",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  createdAt: "2026-11-16T04:00:00Z",
  updatedAt: "2026-11-16T04:20:00Z",
  runStartedAt: "2026-11-16T04:00:00Z",
  htmlUrl: "https://example.test/run/1",
  actor: "someone",
  displayTitle: "Release 3.22.0",
  ...over
});

const plan = (packages = []) => ({
  changesets: packages.length ? [{ name: "a", bumps: {}, description: "Fix" }] : [],
  packages,
  releaseTag: null,
  buildDesktopArtifacts: false
});

const inspector = {
  name: "@mcpjam/inspector",
  currentVersion: "3.22.0",
  newVersion: "3.23.0",
  bumpType: "minor",
  changesets: ["a"]
};

const base = {
  activeRelease: null,
  activePrepare: null,
  unpublished: [],
  plan: plan(),
  recentRuns: [],
  now: Date.parse("2026-11-17T00:00:00Z")
};

test("pending changesets: ready, and the button starts a release", () => {
  const status = deriveReleaseStatus({ ...base, plan: plan([inspector]) });
  assert.deepEqual(status, { kind: "ready", label: "3.23.0", from: "3.22.0", changes: 1 });
  assert.equal(releaseAction(status), "start");
});

test("Start release still versioning: running, no second button", () => {
  const status = deriveReleaseStatus({
    ...base,
    activePrepare: run({ status: "in_progress", displayTitle: "Start release" }),
    plan: plan([inspector])
  });
  assert.equal(status.kind, "running");
  assert.equal(status.label, null);
  assert.equal(releaseAction(status), null);
});

test("a release run in flight names its version", () => {
  const status = deriveReleaseStatus({
    ...base,
    activeRelease: run({ status: "in_progress", displayTitle: "Release 3.23.0" })
  });
  assert.equal(status.kind, "running");
  assert.equal(status.label, "3.23.0");
});

test("versions on main whose run failed: stopped, and the button retries", () => {
  const status = deriveReleaseStatus({
    ...base,
    unpublished: [{ name: "@mcpjam/inspector", newVersion: "3.23.0" }],
    recentRuns: [run({ conclusion: "failure", displayTitle: "Release 3.23.0" })]
  });
  assert.equal(status.kind, "stopped");
  assert.equal(releaseAction(status), "publish");
});

test("versions on main with no run: waiting, still retryable", () => {
  const status = deriveReleaseStatus({
    ...base,
    unpublished: [{ name: "@mcpjam/inspector", newVersion: "3.23.0" }],
    recentRuns: [run({ conclusion: "failure", displayTitle: "Release 3.22.0" })]
  });
  assert.deepEqual(status, { kind: "waiting", label: "3.23.0" });
  assert.equal(releaseAction(status), "publish");
});

test("npm still catching up after a successful run: publishing, no button", () => {
  const status = deriveReleaseStatus({
    ...base,
    now: Date.parse("2026-11-16T09:35:00Z"),
    // Inspector already shows on npm; only the SDK is still missing, so the
    // leftover label would not match the run's.
    unpublished: [{ name: "@mcpjam/sdk", newVersion: "10.9.0" }],
    recentRuns: [run({ displayTitle: "Release 3.23.0", updatedAt: "2026-11-16T09:30:49Z" })]
  });
  assert.equal(status.kind, "publishing");
  assert.equal(status.label, "3.23.0");
  assert.equal(releaseAction(status), null);
});

test("still missing long after the run succeeded: retryable again", () => {
  const status = deriveReleaseStatus({
    ...base,
    now: Date.parse("2026-11-16T10:30:00Z"),
    unpublished: [{ name: "@mcpjam/sdk", newVersion: "10.9.0" }],
    recentRuns: [run({ displayTitle: "Release 3.23.0", updatedAt: "2026-11-16T09:30:49Z" })]
  });
  assert.equal(status.kind, "waiting");
  assert.equal(releaseAction(status), "publish");
});

test("a failed npm read is unknown, never 'nothing to release'", () => {
  const status = deriveReleaseStatus({ ...base, unpublished: new Error("npm 503") });
  assert.deepEqual(status, { kind: "unknown", reason: "npm 503" });
  assert.equal(releaseAction(status), null);
});

test("nothing pending: idle, no button", () => {
  const status = deriveReleaseStatus(base);
  assert.deepEqual(status, { kind: "idle" });
  assert.equal(releaseAction(status), null);
});

test("typical duration is the median of recent successful runs", () => {
  const runs = [
    run({ updatedAt: "2026-11-16T04:18:00Z" }),
    run({ conclusion: "failure", updatedAt: "2026-11-16T06:00:00Z" }),
    run({ updatedAt: "2026-11-16T04:22:00Z" }),
    run({ updatedAt: "2026-11-16T05:00:00Z" })
  ];
  assert.equal(typicalReleaseMinutes(runs), 22);
  assert.equal(typicalReleaseMinutes([]), null);
});
