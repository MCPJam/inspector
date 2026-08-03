import assert from "node:assert/strict";
import test from "node:test";
import {
  conformanceExitCode,
  conformanceSuiteExitCode,
} from "../src/lib/conformance-exit-code.js";

test("incomplete gets its own exit code, distinct from a violation", () => {
  // "The server violated the spec" and "we never established anything" are
  // different failures with different fixes. 2 is taken by usage errors.
  assert.equal(conformanceExitCode({ passed: false, outcome: "incomplete" }), 3);
  assert.equal(conformanceExitCode({ passed: false, outcome: "failed" }), 1);
  assert.equal(conformanceExitCode({ passed: true, outcome: "passed" }), 0);
});

test("falls back to passed when the SDK predates outcome", () => {
  assert.equal(conformanceExitCode({ passed: true }), 0);
  assert.equal(conformanceExitCode({ passed: false }), 1);
});

test("a suite takes the worst of its runs, failure outranking incomplete", () => {
  assert.equal(
    conformanceSuiteExitCode([
      { passed: true, outcome: "passed" },
      { passed: false, outcome: "incomplete" },
      { passed: false, outcome: "failed" },
    ]),
    1,
  );
  assert.equal(
    conformanceSuiteExitCode([
      { passed: true, outcome: "passed" },
      { passed: false, outcome: "incomplete" },
    ]),
    3,
  );
  assert.equal(
    conformanceSuiteExitCode([{ passed: true, outcome: "passed" }]),
    0,
  );
});
