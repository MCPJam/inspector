import assert from "node:assert/strict";
import { test } from "node:test";
import { dailyReleaseDecision } from "./daily-release.mjs";

const ready = {
  activeRun: null,
  versionPr: null,
  unpublished: [],
  releases: [{ name: "@mcpjam/inspector", type: "patch" }],
};

test("prepares a full production release when Inspector has pending changes", () => {
  assert.equal(dailyReleaseDecision(ready).dispatch, true);
});

test("does not overlap active release work or replace a version PR awaiting review", () => {
  for (const key of ["activeRun", "versionPr"]) {
    const url = `https://github.com/MCPJam/inspector/${key}`;
    const decision = dailyReleaseDecision({ ...ready, [key]: url });
    assert.equal(decision.dispatch, false);
    assert.ok(decision.reason.includes(url));
  }
});

test("leaves unpublished versions for the existing release to complete", () => {
  assert.equal(dailyReleaseDecision({
    ...ready,
    unpublished: [{ name: "@mcpjam/inspector", newVersion: "1.2.3" }],
  }).dispatch, false);
});

test("skips empty, no-op and packages-only plans without inventing a version bump", () => {
  for (const releases of [
    [],
    [{ name: "@mcpjam/inspector", type: "none" }],
    [{ name: "@mcpjam/sdk", type: "patch" }],
  ]) {
    assert.equal(dailyReleaseDecision({ ...ready, releases }).dispatch, false);
  }
});
