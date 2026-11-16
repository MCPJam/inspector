import assert from "node:assert/strict";
import { test } from "node:test";
import { activeRunUrl, dailyReleaseDecision } from "./daily-release.mjs";

const ready = {
  activeRun: null,
  unpublished: [],
  releases: [{ name: "@mcpjam/inspector", type: "patch" }],
};

test("reminds #prs when Inspector has pending changes", () => {
  assert.equal(dailyReleaseDecision(ready).dispatch, true);
});

test("stays quiet while release work is running", () => {
  const url = "https://github.com/MCPJam/inspector/actions/runs/1";
  const decision = dailyReleaseDecision({ ...ready, activeRun: url });
  assert.equal(decision.dispatch, false);
  const match = decision.reason.match(/https:\/\/\S+/);
  assert.ok(match);
  assert.equal(new URL(match[0]).href, new URL(url).href);
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

test("treats any unfinished run as active release work", () => {
  const url = "https://github.com/MCPJam/inspector/actions/runs/2";
  for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
    assert.equal(activeRunUrl([{ status: "completed", html_url: "done" }, { status, html_url: url }]), url);
  }
  assert.equal(activeRunUrl([{ status: "completed", html_url: "done" }]), null);
  assert.equal(activeRunUrl([]), null);
});
