import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRelease,
  releaseLabel,
  releaseRunName,
  REQUIRED_CHECKS,
} from "./release-trigger.mjs";

const unpublished = [
  { name: "@mcpjam/sdk", newVersion: "8.18.0" },
  { name: "@mcpjam/inspector", newVersion: "3.12.3" },
];
const ready = {
  headSha: "abc",
  mainSha: "abc",
  greenChecks: REQUIRED_CHECKS,
  unpublished,
  releaseRuns: [],
};

test("dispatches once the tip of main is green and carries new versions", () => {
  assert.deepEqual(decideRelease(ready), {
    dispatch: true,
    label: "3.12.3",
    reason: "Releasing 3.12.3 at abc.",
  });
});

test("leaves a commit that is no longer the tip to the newer one", () => {
  assert.equal(decideRelease({ ...ready, mainSha: "def" }).dispatch, false);
});

test("waits for every required check", () => {
  for (const missing of REQUIRED_CHECKS) {
    const decision = decideRelease({
      ...ready,
      greenChecks: REQUIRED_CHECKS.filter((w) => w !== missing),
    });
    assert.equal(decision.dispatch, false);
    assert.match(decision.reason, new RegExp(missing.replace(".", "\\.")));
  }
});

test("does nothing when everything is already on npm", () => {
  assert.equal(decideRelease({ ...ready, unpublished: [] }).dispatch, false);
});

test("never stacks a second run on one in flight", () => {
  for (const status of ["queued", "in_progress", "waiting", "pending"]) {
    const releaseRuns = [{ status, conclusion: null, displayTitle: "Release" }];
    assert.equal(decideRelease({ ...ready, releaseRuns }).dispatch, false);
  }
});

test("does not retry a failed or cancelled automatic release of the same versions", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out"]) {
    const releaseRuns = [
      { status: "completed", conclusion, displayTitle: "Release 3.12.3" },
    ];
    const decision = decideRelease({ ...ready, releaseRuns });
    assert.equal(decision.dispatch, false);
    assert.match(decision.reason, new RegExp(conclusion));
  }
});

test("dispatches again after a no-op run of the same versions", () => {
  const releaseRuns = [
    { status: "completed", conclusion: "success", displayTitle: "Release 3.12.3" },
  ];
  assert.equal(decideRelease({ ...ready, releaseRuns }).dispatch, true);
});

test("a failed run of other versions does not block these", () => {
  const releaseRuns = [
    { status: "completed", conclusion: "failure", displayTitle: "Release 3.12.2" },
    { status: "completed", conclusion: "failure", displayTitle: "Release" },
  ];
  assert.equal(decideRelease({ ...ready, releaseRuns }).dispatch, true);
});

test("labels a packages-only release by package", () => {
  const label = releaseLabel(unpublished.slice(0, 1));
  assert.equal(label, "@mcpjam/sdk 8.18.0");
  assert.equal(releaseRunName(label), "Release @mcpjam/sdk 8.18.0");
});
