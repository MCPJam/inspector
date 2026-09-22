import assert from "node:assert/strict";
import test from "node:test";
import {
  conformanceExitCode,
  conformanceSuiteExitCode,
  reportReadiness,
  reportScore,
} from "../src/lib/conformance-exit-code.js";
import { computeConformanceScore } from "@mcpjam/sdk";

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

test("readiness advice goes to stderr, honors --quiet, and prints nothing for an older SDK", () => {
  const lines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const command = { optsWithGlobals: () => ({}) };
    reportReadiness(
      {
        readiness: [
          {
            specStrength: "SHOULD",
            title: "Explicit Session Termination",
            message: "DELETE with the session id got HTTP 500",
          },
        ],
      },
      command,
    );
    assert.equal(lines.length, 2);
    assert.match(lines[0], /Advice \(1\):/);
    assert.match(lines[1], /\[SHOULD\] Explicit Session Termination: DELETE/);

    lines.length = 0;
    reportReadiness(
      { readiness: [{ specStrength: "MAY", title: "x", message: "y" }] },
      { optsWithGlobals: () => ({ quiet: true }) },
    );
    assert.equal(lines.length, 0);

    // An older @mcpjam/sdk result has no readiness member at all.
    reportReadiness({}, command);
    assert.equal(lines.length, 0);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("the score line goes to stderr with denominator and version, and honors --quiet", () => {
  const lines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const score = computeConformanceScore(
      [
        { id: "a", status: "passed" },
        { id: "b", status: "failed" },
      ],
      [{ id: "advice", tier: "should" }],
      "2025-11-25",
    );
    reportScore(score, { optsWithGlobals: () => ({}) });
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0],
      "Score: 51/100 — 1/2 applicable checks passed, 1 failed, 1 advisory (−2) [2025-11-25]\n",
    );

    lines.length = 0;
    reportScore(score, { optsWithGlobals: () => ({}) }, "run-1");
    assert.match(lines[0], /^Score \[run-1\]: /);

    lines.length = 0;
    reportScore(score, { optsWithGlobals: () => ({ quiet: true }) });
    assert.equal(lines.length, 0);
  } finally {
    process.stderr.write = originalWrite;
  }
});
