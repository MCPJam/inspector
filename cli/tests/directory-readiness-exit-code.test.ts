/**
 * The exit code a CI job reads, and the two lines a human reads.
 *
 * The mapping is the same one every other gate in this CLI uses, and the
 * reason it needs its own function rather than reusing `conformanceExitCode`
 * is a SHAPE difference that fails silently: a conformance result reports
 * `{passed, outcome}` and a readiness result reports a single `status`. Handed
 * to the conformance version, an incomplete readiness run reads `passed:
 * undefined` and maps to `1` — a run that established nothing reported as a
 * violation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  directoryReadinessExitCode,
  reportReadinessGaps,
  reportReadinessVerdict,
} from "../src/lib/directory-readiness-exit-code.js";

/** A `command` stand-in: the only thing the reporters read is `--quiet`. */
function commandWith(quiet = false) {
  return { optsWithGlobals: () => ({ quiet }) };
}

/** Capture stderr for the duration of one call. */
function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as unknown as { write: unknown }).write = (
    chunk: string,
  ): boolean => {
    captured += chunk;
    return true;
  };
  try {
    run();
  } finally {
    (process.stderr as unknown as { write: unknown }).write = original;
  }
  return captured;
}

test("ready is a pass", () => {
  assert.equal(directoryReadinessExitCode({ status: "ready" }), 0);
});

test("not-ready is a failure", () => {
  assert.equal(directoryReadinessExitCode({ status: "not-ready" }), 1);
});

test("incomplete gets its own code, never 1", () => {
  // A gate that fails identically whether the connector is broken or our own
  // run could not reach it teaches its owner nothing.
  assert.equal(directoryReadinessExitCode({ status: "incomplete" }), 3);
});

test("an unrecognised status is incomplete, never ready", () => {
  // Read structurally so a result from a newer or older SDK still maps. The
  // direction matters: guessing `ready` would turn an unknown state into a
  // green build.
  assert.equal(directoryReadinessExitCode({ status: "surprise" }), 3);
  assert.equal(directoryReadinessExitCode({}), 3);
});

test("the verdict line names the status and carries the summary", () => {
  const out = captureStderr(() =>
    reportReadinessVerdict(
      {
        status: "not-ready",
        summary: "directory-policy has unmet requirements.",
      },
      commandWith(),
    ),
  );
  assert.match(out, /NOT READY/);
  assert.match(out, /directory-policy has unmet requirements\./);
});

test("--quiet silences the verdict, and stdout stays parseable", () => {
  const out = captureStderr(() =>
    reportReadinessVerdict({ status: "ready" }, commandWith(true)),
  );
  assert.equal(out, "");
});

test("gaps name the input that would close them", () => {
  // The sentence a submitter acts on: an `incomplete` verdict without the
  // next action is an adjective, not an answer.
  const out = captureStderr(() =>
    reportReadinessGaps(
      {
        lanes: [
          {
            lane: "directory-policy",
            coverage: { missingInputs: ["toolListing"], notEvaluated: 2 },
          },
          {
            lane: "runtime-compatibility",
            coverage: { missingInputs: [], notEvaluated: 0 },
          },
        ],
      },
      commandWith(),
    ),
  );
  assert.match(out, /Gaps \(1\):/);
  assert.match(out, /directory-policy: supply toolListing/);
  // A lane with nothing outstanding is not listed as a gap.
  assert.doesNotMatch(out, /runtime-compatibility/);
});

test("a lane whose checks could not run is a gap even with no named input", () => {
  const out = captureStderr(() =>
    reportReadinessGaps(
      {
        lanes: [{ lane: "optional-features", coverage: { notEvaluated: 2 } }],
      },
      commandWith(),
    ),
  );
  assert.match(out, /optional-features: 2 check\(s\) could not run/);
});

test("gaps are reported even when the rollup reads ready", () => {
  // A lane can carry a gap while the headline still says ready; hiding that
  // would make a partial pass look total.
  const out = captureStderr(() =>
    reportReadinessGaps(
      {
        lanes: [
          {
            lane: "optional-features",
            coverage: { missingInputs: ["pluginBundle"] },
          },
        ],
      },
      commandWith(),
    ),
  );
  assert.match(out, /optional-features: supply pluginBundle/);
});
