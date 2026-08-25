/**
 * The public v1 verdict-policy projection (verdict policy v2).
 *
 * What these tests guard is narrower than "the fields are present": it is that
 * a caller GATING on the DTO cannot read a pass, or a legacy shape, out of
 * evidence the backend did not produce.
 *
 *   - A legacy run/suite projects NOTHING, so an operator can tell "decided
 *     under v2 with no readable summary" from "graded by a percent".
 *   - A decision that fails canonical validation is ABSENT rather than
 *     partially published: `verdictSummary` is where the denominators and the
 *     failed checks live, and half of those is not a weaker audit trail, it is
 *     an unfalsifiable one.
 *
 * The accepted decision is taken from the canonical parity corpus rather than
 * hand-written, so a contract change that invalidates it fails here instead of
 * being re-encoded in a fixture that only agrees with this test.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  toRunVerdictProjection,
  toSuiteVerdictPolicyDto,
} from "../eval-verdict-projection.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    resolve(
      here,
      "../../../../../sdk/tests/fixtures/eval-verdict-policy-parity-fixtures.json",
    ),
    "utf8",
  ),
) as {
  accept: Array<Record<string, unknown> & { __kind: string }>;
  reject: Array<Record<string, unknown> & { __kind: string }>;
};

/** Strip the corpus' documentation keys; they are not part of the wire shape. */
function payloadOf(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !key.startsWith("__")),
  );
}

const acceptedDecision = payloadOf(
  corpus.accept.find((row) => row.__kind === "decision")!,
);
const rejectedDecision = payloadOf(
  corpus.reject.find((row) => row.__kind === "decision")!,
);

describe("toRunVerdictProjection", () => {
  it("projects nothing for a legacy run", () => {
    expect(toRunVerdictProjection({})).toEqual({});
    expect(
      toRunVerdictProjection({ verdictSummary: acceptedDecision }),
    ).toEqual({});
  });

  it("does not treat a non-2 policy version as v2", () => {
    for (const version of [1, 3, "2", null, true]) {
      expect(
        toRunVerdictProjection({
          verdictPolicyVersion: version,
          verdictSummary: acceptedDecision,
        }),
      ).toEqual({});
    }
  });

  it("projects the version and a canonical decision", () => {
    expect(
      toRunVerdictProjection({
        verdictPolicyVersion: 2,
        verdictSummary: acceptedDecision,
      }),
    ).toEqual({
      verdictPolicyVersion: 2,
      verdictSummary: acceptedDecision,
    });
  });

  it("keeps the version when the stored decision does not validate", () => {
    // The version survives on its own: a v2 run whose summary is unreadable is
    // still a v2 run, and reporting it as legacy would tell a caller its
    // `result` can never be `inconclusive` — which is exactly the case a
    // malformed summary accompanies.
    for (const summary of [rejectedDecision, {}, null, "passed", []]) {
      expect(
        toRunVerdictProjection({
          verdictPolicyVersion: 2,
          verdictSummary: summary,
        }),
      ).toEqual({ verdictPolicyVersion: 2 });
    }
  });

  it("projects an integrity error independently of the summary", () => {
    expect(
      toRunVerdictProjection({
        verdictPolicyVersion: 2,
        verdictPolicyIntegrityError: "policy snapshot missing",
      }),
    ).toEqual({
      verdictPolicyVersion: 2,
      verdictPolicyIntegrityError: "policy snapshot missing",
    });
  });

  it("omits a blank or non-string integrity error", () => {
    for (const error of ["", 7, null, {}]) {
      expect(
        toRunVerdictProjection({
          verdictPolicyVersion: 2,
          verdictPolicyIntegrityError: error,
        }),
      ).toEqual({ verdictPolicyVersion: 2 });
    }
  });
});

describe("toSuiteVerdictPolicyDto", () => {
  const defaults = { repetitions: 3, passThreshold: 0.5 };

  it("projects nothing for a legacy suite", () => {
    expect(toSuiteVerdictPolicyDto({})).toEqual({});
    expect(
      toSuiteVerdictPolicyDto({ verdictPolicyDefaults: defaults }),
    ).toEqual({});
  });

  it("projects the version and whole defaults", () => {
    expect(
      toSuiteVerdictPolicyDto({
        verdictPolicyVersion: 2,
        verdictPolicyDefaults: defaults,
      }),
    ).toEqual({ verdictPolicyVersion: 2, verdictPolicyDefaults: defaults });
  });

  it("carries the declared validity policy verbatim", () => {
    const withValidity = {
      repetitions: 5,
      passThreshold: 1,
      validity: { minEligibleTrials: 2, maxEvaluatorErrorRate: 0 },
    };
    expect(
      toSuiteVerdictPolicyDto({
        verdictPolicyVersion: 2,
        verdictPolicyDefaults: withValidity,
      }),
    ).toEqual({
      verdictPolicyVersion: 2,
      verdictPolicyDefaults: withValidity,
    });
  });

  it("omits defaults that are partial, out of range, or percent-shaped", () => {
    const invalid = [
      { repetitions: 3 },
      { passThreshold: 0.5 },
      // 80 is the legacy percent. Projecting it as a fraction is the exact
      // reinterpretation the two policies must never make of each other.
      { repetitions: 3, passThreshold: 80 },
      { repetitions: 0, passThreshold: 0.5 },
      { repetitions: 1.5, passThreshold: 0.5 },
      { repetitions: 3, passThreshold: 0.5, minimumPassRate: 80 },
      { repetitions: 3, passThreshold: 0.5, validity: { minCompletionRate: 8 } },
      null,
    ];
    for (const value of invalid) {
      expect(
        toSuiteVerdictPolicyDto({
          verdictPolicyVersion: 2,
          verdictPolicyDefaults: value,
        }),
      ).toEqual({ verdictPolicyVersion: 2 });
    }
  });
});
