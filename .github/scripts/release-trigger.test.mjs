import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideRelease,
  RELEASE_WINDOW,
  releaseLabel,
  releaseRunName,
  releaseWindowOpen,
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
  inWindow: true,
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

test("skip_verify releases without waiting for any check", () => {
  const decision = decideRelease({ ...ready, greenChecks: [], skipVerify: true });
  assert.equal(decision.dispatch, true);
  assert.match(decision.reason, /skip_verify/);
});

test("skip_verify still ships only the tip, only once, and only what npm lacks", () => {
  const base = { ...ready, greenChecks: [], skipVerify: true };
  assert.equal(decideRelease({ ...base, mainSha: "def" }).dispatch, false);
  assert.equal(decideRelease({ ...base, unpublished: [] }).dispatch, false);
  const releaseRuns = [{ status: "in_progress", conclusion: null, displayTitle: "Release 3.12.3" }];
  assert.equal(decideRelease({ ...base, releaseRuns }).dispatch, false);
});

test("holds a ready release until the window opens", () => {
  const decision = decideRelease({ ...ready, inWindow: false });
  assert.equal(decision.dispatch, false);
  assert.match(decision.reason, /holds for the release window/);
});

test("a caller that does not say the window is open holds", () => {
  const { inWindow, ...rest } = ready;
  assert.equal(decideRelease(rest).dispatch, false);
});

test("outside the window, a reason that needs action still comes first", () => {
  const red = decideRelease({ ...ready, inWindow: false, greenChecks: [] });
  assert.match(red.reason, /^Waiting on/);
  const failed = decideRelease({
    ...ready,
    inWindow: false,
    releaseRuns: [{ status: "completed", conclusion: "failure", displayTitle: "Release 3.12.3" }],
  });
  assert.match(failed.reason, /ended "failure"/);
});

test("skip_verify releases outside the window", () => {
  const decision = decideRelease({ ...ready, inWindow: false, greenChecks: [], skipVerify: true });
  assert.equal(decision.dispatch, true);
});

test("the window is 5 PM to 9 PM Pacific, Sunday to Friday, across daylight saving", () => {
  const open = (iso) => releaseWindowOpen(new Date(iso));
  assert.equal(open("2026-10-16T23:59:00Z"), false); // Fri 16:59 PDT
  assert.equal(open("2026-10-17T00:00:00Z"), true); // Fri 17:00 PDT
  assert.equal(open("2026-10-17T03:59:00Z"), true); // Fri 20:59 PDT
  assert.equal(open("2026-10-17T04:00:00Z"), false); // Fri 21:00 PDT
  assert.equal(open("2026-10-18T01:00:00Z"), false); // Sat 18:00 PDT
  assert.equal(open("2026-10-19T00:30:00Z"), true); // Sun 17:30 PDT
  assert.equal(open("2026-11-03T00:30:00Z"), false); // Mon 16:30 PST
  assert.equal(open("2026-11-03T01:00:00Z"), true); // Mon 17:00 PST
});

test("Soundcheck's hand-synced copy of the release window matches", () => {
  const source = readFileSync(
    new URL("../../soundcheck/src/lib/release-state.ts", import.meta.url),
    "utf8"
  );
  const block = source.match(/export const RELEASE_WINDOW = \{([\s\S]*?)\n\};/)?.[1];
  assert.ok(block, "release-state.ts no longer exports RELEASE_WINDOW");
  const field = (name) => block.match(new RegExp(`^\\s*${name}: (.*?),?$`, "m"))?.[1];
  assert.deepEqual(
    {
      timeZone: JSON.parse(field("timeZone")),
      days: JSON.parse(field("days")),
      startHour: Number(field("startHour")),
      endHour: Number(field("endHour")),
      label: JSON.parse(field("label")),
    },
    RELEASE_WINDOW
  );
});
