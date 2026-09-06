/**
 * Gate 4 — the gate engine matrix.
 *
 * Two properties carry the weight here, and both are about NOT saying "pass"
 * when nothing was established:
 *
 *   1. The score-integrity TRI-STATE. `undefined` is not "fine"; it means no
 *      verdict exists, and a score gate must treat it exactly like `invalid`.
 *      The backend that produces this verdict ships separately, so until then
 *      every score gate is undecidable — by design.
 *   2. Infrastructure never maps to an eval-failure exit code.
 */

import { describe, expect, it } from "vitest";
import {
  COMPARATIVE_GATE_FIELDS,
  GateError,
  assertGate,
  evaluateGates,
  formatGateReport,
  gateInputFromPlatformRun,
  gateInputFromRunResult,
  gateOutcomeVerdict,
  passRateFractionFromPercent,
  type GateInput,
  type GatePolicy,
  type GateScore,
} from "../src/gates.js";
import {
  buildEvaluationConfigSnapshot,
  definitionHash,
  resolveScoreDefinition,
} from "../src/contract/derive.js";
import { gateInputFromSuiteResult } from "../src/gates.js";
import { scoresPassed } from "../src/scorers/run.js";
import type { ScoreDefinition } from "../src/contract/types.js";

const GATING: ScoreDefinition = {
  scorerId: "refund",
  idSource: "explicit",
  scorerVersion: "1",
  implementationHash: "impl-refund",
  deterministic: true,
  passThreshold: 1,
  role: "gating",
};

const JUDGE: ScoreDefinition = {
  scorerId: "tone",
  idSource: "explicit",
  scorerVersion: "1",
  implementationHash: "impl-tone",
  deterministic: false,
  passThreshold: 0.7,
  role: "gating",
};

const GENERATED: ScoreDefinition = {
  scorerId: "predicate:responseContains#0",
  idSource: "generated",
  scorerVersion: "1",
  implementationHash: "impl-generated",
  deterministic: true,
  passThreshold: 1,
  role: "gating",
};

const snapshot = buildEvaluationConfigSnapshot([GATING, JUDGE, GENERATED]);
const hashes = {
  refund: definitionHash(resolveScoreDefinition(GATING)),
  tone: definitionHash(resolveScoreDefinition(JUDGE)),
  generated: definitionHash(resolveScoreDefinition(GENERATED)),
};

function score(
  scorerId: keyof typeof hashes,
  over: Partial<GateScore> = {}
): GateScore {
  return {
    scorerId: scorerId === "generated" ? GENERATED.scorerId : scorerId,
    definitionHash: hashes[scorerId],
    status: "scored",
    value: 1,
    passed: true,
    ...over,
  };
}

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    iterations: { total: 10, passed: 10 },
    evaluationConfig: snapshot,
    scores: [score("refund"), score("tone", { value: 0.9 })],
    scoreIntegrity: "valid",
    totals: { tokens: 1000, e2eP95Ms: 500 },
    ...over,
  };
}

describe("pass-rate gate", () => {
  it("passes at the threshold and fails below it", () => {
    expect(
      evaluateGates(input({ iterations: { total: 10, passed: 9 } }), {
        minimumPassRate: 0.9,
      }).outcome
    ).toBe("passed");
    expect(
      evaluateGates(input({ iterations: { total: 10, passed: 8 } }), {
        minimumPassRate: 0.9,
      }).outcome
    ).toBe("failed");
  });

  it("pins the percent→fraction boundary at exactly 1", () => {
    // `100 / 100` must be 1 EXACTLY. A hair under, and a fully-passing run
    // fails the most common gate anybody writes.
    const fraction = passRateFractionFromPercent(100);
    expect(fraction).toBe(1);
    expect(
      evaluateGates(input({ iterations: { total: 3, passed: 3 } }), {
        minimumPassRate: fraction,
      }).outcome
    ).toBe("passed");
    expect(
      evaluateGates(input({ iterations: { total: 3, passed: 2 } }), {
        minimumPassRate: fraction,
      }).outcome
    ).toBe("failed");
  });

  it("treats 0 as a real threshold, distinct from unset", () => {
    const zero = evaluateGates(input({ iterations: { total: 2, passed: 0 } }), {
      minimumPassRate: 0,
    });
    expect(zero.outcome).toBe("passed");
    expect(zero.verdicts).toHaveLength(1);

    const unset = evaluateGates(input({ iterations: { total: 2, passed: 0 } }), {});
    expect(unset.verdicts).toHaveLength(0);
    expect(unset.outcome).toBe("passed");
  });

  it("is non-gateable on a run with no iterations", () => {
    const report = evaluateGates(
      input({ iterations: { total: 0, passed: 0 } }),
      { minimumPassRate: 1 }
    );
    expect(report.outcome).toBe("incomplete");
  });

  it("rejects an out-of-range threshold as a USAGE error, not a failure", () => {
    // Almost certainly someone passing 90 meaning 90%.
    const report = evaluateGates(input(), { minimumPassRate: 90 });
    expect(report.outcome).toBe("usage_error");
  });
});

describe("score-integrity tri-state", () => {
  const scoreGate = { minimumScorerPassRate: { refund: 1 } };

  it("valid ⇒ score gates evaluate normally", () => {
    expect(
      evaluateGates(input({ scoreIntegrity: "valid" }), scoreGate).outcome
    ).toBe("passed");
    expect(
      evaluateGates(
        input({
          scoreIntegrity: "valid",
          scores: [score("refund", { value: 0, passed: false })],
        }),
        scoreGate
      ).outcome
    ).toBe("failed");
  });

  it("invalid ⇒ non-gateable (exit 3), never passed", () => {
    const report = evaluateGates(
      input({ scoreIntegrity: "invalid" }),
      scoreGate
    );
    expect(report.outcome).toBe("incomplete");
    expect(report.verdicts[0].message).toContain("did not verify");
  });

  it("UNDEFINED + a score gate ⇒ non-gateable (exit 3)", () => {
    // The whole point. Absent evidence is not valid evidence — and this is the
    // state every run is in until the backend integrity check ships.
    const report = evaluateGates(
      input({ scoreIntegrity: undefined }),
      scoreGate
    );
    expect(report.outcome).toBe("incomplete");
    expect(report.scoreIntegrity).toBe("unknown");
  });

  it("UNDEFINED never maps to 0 for ANY score gate", () => {
    // Asserted across every score-derived gate, not just one, so adding a new
    // score gate that forgets the check fails here.
    const policies = [
      { minimumScorerPassRate: { refund: 1 } },
      { minimumMeanScore: { tone: 0.5 } },
      { noGatingScoreErrors: true },
    ];
    for (const policy of policies) {
      const report = evaluateGates(input({ scoreIntegrity: undefined }), policy);
      expect(report.outcome, JSON.stringify(policy)).not.toBe("passed");
      expect(report.outcome, JSON.stringify(policy)).toBe("incomplete");
    }
  });

  it("UNDEFINED + a pass-rate gate ONLY ⇒ evaluates normally", () => {
    // The pass-rate gate is fully usable before the backend ships: it reads
    // iteration counts, not score evidence.
    const passing = evaluateGates(
      input({ scoreIntegrity: undefined, iterations: { total: 4, passed: 4 } }),
      { minimumPassRate: 1 }
    );
    expect(passing.outcome).toBe("passed");

    const failing = evaluateGates(
      input({ scoreIntegrity: undefined, iterations: { total: 4, passed: 3 } }),
      { minimumPassRate: 1 }
    );
    expect(failing.outcome).toBe("failed");
  });

  it("token and latency gates are unaffected by integrity", () => {
    const report = evaluateGates(input({ scoreIntegrity: undefined }), {
      maximumTotalTokens: 2000,
      maximumP95LatencyMs: 1000,
    });
    expect(report.outcome).toBe("passed");
  });

  it("an exceeded resource budget FAILS rather than passing vacuously", () => {
    expect(
      evaluateGates(input(), { maximumTotalTokens: 999 }).outcome
    ).toBe("failed");
    expect(
      evaluateGates(input(), { maximumP95LatencyMs: 499 }).outcome
    ).toBe("failed");
  });

  it("an ABSENT total is non-gateable, never a pass", () => {
    // A cap evaluated against a missing total would silently read as 0.
    expect(
      evaluateGates(input({ totals: undefined }), { maximumTotalTokens: 2000 })
        .outcome
    ).toBe("incomplete");
    expect(
      evaluateGates(input({ totals: {} }), { maximumP95LatencyMs: 1000 })
        .outcome
    ).toBe("incomplete");
  });
});

describe("scoresPassed", () => {
  const definitions = [GATING, JUDGE].map(resolveScoreDefinition);

  it("passes when every gating definition is represented and green", () => {
    expect(
      scoresPassed(
        [
          { ...score("refund"), scorerVersion: "1", deterministic: true },
          { ...score("tone"), scorerVersion: "1", deterministic: false },
        ] as never,
        definitions
      )
    ).toBe(true);
  });

  it("FAILS when a gating definition produced no row at all", () => {
    // Iterating scores alone never enters the loop for a missing scorer, so
    // this used to pass — absent evidence reading as a pass.
    expect(
      scoresPassed(
        [{ ...score("refund"), scorerVersion: "1", deterministic: true }] as never,
        definitions
      )
    ).toBe(false);
  });

  it("does not require ADVISORY definitions to be represented", () => {
    const advisoryDefinitions = [
      resolveScoreDefinition(GATING),
      resolveScoreDefinition({ ...JUDGE, role: "advisory" }),
    ];
    expect(
      scoresPassed(
        [{ ...score("refund"), scorerVersion: "1", deterministic: true }] as never,
        advisoryDefinitions
      )
    ).toBe(true);
  });
});

describe("scorer selection", () => {
  it("rejects a scorerId absent from the snapshot as a usage error", () => {
    const report = evaluateGates(input(), {
      minimumScorerPassRate: { "typo-scorer": 1 },
    });
    expect(report.outcome).toBe("usage_error");
    expect(report.verdicts[0].message).toContain("no scorer");
  });

  it("rejects a GENERATED (positional) scorer id as a usage error", () => {
    // Generated ids renumber when the scorer list changes, so a gate that
    // tracked one would silently follow a different scorer after an edit.
    const report = evaluateGates(input(), {
      minimumScorerPassRate: { [GENERATED.scorerId]: 1 },
    });
    expect(report.outcome).toBe("usage_error");
    expect(report.verdicts[0].message).toContain("positional id");
  });

  it("reports a usage error even when the run is non-gateable", () => {
    // A typo is worth telling the author about regardless of whether this
    // particular run could have answered.
    const report = evaluateGates(input({ scoreIntegrity: undefined }), {
      minimumScorerPassRate: { nope: 1 },
    });
    expect(report.outcome).toBe("usage_error");
  });
});

describe("aggregation", () => {
  it("excludes not_applicable from the denominator", () => {
    const report = evaluateGates(
      input({
        scores: [
          score("refund"),
          score("refund", {
            status: "not_applicable",
            value: undefined,
            passed: undefined,
          }),
        ],
      }),
      { minimumScorerPassRate: { refund: 1 } }
    );
    // 1/1, not 1/2 — `not_applicable` means the scorer was never in scope.
    expect(report.outcome).toBe("passed");
    expect(report.verdicts[0].message).toContain("1/1");
  });

  it("counts an errored row in the denominator (it did not pass)", () => {
    const report = evaluateGates(
      input({
        scores: [
          score("refund"),
          score("refund", {
            status: "error",
            value: undefined,
            passed: undefined,
          }),
        ],
      }),
      { minimumScorerPassRate: { refund: 1 } }
    );
    expect(report.outcome).toBe("failed");
    expect(report.verdicts[0].message).toContain("1/2");
  });

  it("is non-gateable when only not_applicable rows exist", () => {
    const report = evaluateGates(
      input({
        scores: [
          score("refund", {
            status: "not_applicable",
            value: undefined,
            passed: undefined,
          }),
        ],
      }),
      { minimumScorerPassRate: { refund: 1 } }
    );
    expect(report.outcome).toBe("incomplete");
  });

  it("averages only scored rows for minimumMeanScore", () => {
    const report = evaluateGates(
      input({
        scores: [
          score("tone", { value: 0.8 }),
          score("tone", { value: 0.6, passed: false }),
          // An errored judge has no number; inventing a 0 would conflate
          // "crashed" with "graded badly".
          score("tone", {
            status: "error",
            value: undefined,
            passed: undefined,
          }),
        ],
      }),
      { minimumMeanScore: { tone: 0.7 } }
    );
    expect(report.outcome).toBe("passed");
    expect(report.verdicts[0].observed).toBeCloseTo(0.7, 10);
  });

  it("flags gating scorer errors only for GATING definitions", () => {
    const advisorySnapshot = buildEvaluationConfigSnapshot([
      { ...JUDGE, role: "advisory" },
    ]);
    const report = evaluateGates(
      {
        iterations: { total: 1, passed: 1 },
        evaluationConfig: advisorySnapshot,
        scores: [
          {
            scorerId: "tone",
            definitionHash: definitionHash(
              resolveScoreDefinition({ ...JUDGE, role: "advisory" })
            ),
            status: "error",
          },
        ],
        scoreIntegrity: "valid",
      },
      { noGatingScoreErrors: true }
    );
    expect(report.outcome).toBe("passed");
  });
});

describe("outcome precedence", () => {
  it("a real failure outranks an undecidable gate", () => {
    // A run that both regressed AND had an undecidable gate DID regress;
    // reporting "incomplete" would bury that.
    const report = evaluateGates(
      input({
        scoreIntegrity: undefined,
        iterations: { total: 2, passed: 1 },
      }),
      { minimumPassRate: 1, minimumScorerPassRate: { refund: 1 } }
    );
    expect(report.outcome).toBe("failed");
  });

  it("a broken policy outranks everything", () => {
    const report = evaluateGates(
      input({ iterations: { total: 2, passed: 1 } }),
      { minimumPassRate: 1, minimumScorerPassRate: { unknown: 1 } }
    );
    expect(report.outcome).toBe("usage_error");
  });
});

describe("adapters", () => {
  it("marks a locally-produced run as integrity-valid", () => {
    const built = gateInputFromRunResult({
      iterations: 2,
      successes: 2,
      failures: 0,
      results: [true, true],
      iterationDetails: [],
      tokenUsage: { total: 42, input: 20, output: 22, perIteration: [] },
      latency: {
        e2e: { min: 0, max: 0, mean: 0, p50: 0, p95: 7, count: 2 },
        llm: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 2 },
        mcp: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 2 },
        perIteration: [],
      },
      evaluationConfig: snapshot,
    });
    // Local scores never crossed a boundary where they could be substituted.
    expect(built.scoreIntegrity).toBe("valid");
    expect(built.totals).toEqual({ tokens: 42, e2eP95Ms: 7 });
  });

  it("omits totals and scores when the iteration page is INCOMPLETE", () => {
    const built = gateInputFromPlatformRun(
      {
        id: "run_1",
        suiteId: "s",
        runNumber: 1,
        status: "completed",
        result: "passed",
        summary: { total: 50, passed: 50 },
        source: "sdk",
        notes: null,
        createdAt: 0,
        completedAt: 1,
        scoreIntegrity: "valid",
      },
      {
        complete: false,
        items: [
          {
            id: "i1",
            testCaseId: null,
            title: null,
            iterationNumber: 1,
            status: "completed",
            result: "passed",
            model: null,
            provider: null,
            startedAt: null,
            durationMs: null,
            tokensUsed: 10,
            usage: null,
            actualToolCalls: [],
            expectedToolCalls: [],
            error: null,
            scores: [
              {
                scorerId: "refund",
                scorerVersion: "1",
                definitionHash: hashes.refund,
                status: "scored",
                value: 1,
                passThreshold: 1,
                passed: true,
                deterministic: true,
              },
            ],
            evaluationConfig: snapshot,
          },
        ],
      }
    );
    // Gating on page one of a 50-iteration run would be a confident verdict
    // about a sample.
    expect(built.scores).toBeUndefined();
    expect(built.totals).toBeUndefined();

    const report = evaluateGates(built, { minimumScorerPassRate: { refund: 1 } });
    expect(report.outcome).toBe("incomplete");
  });

  it("merges per-case definitions for a suite, deduplicated by hash", () => {
    const caseA = {
      iterations: 1,
      successes: 1,
      failures: 0,
      results: [true],
      iterationDetails: [
        { passed: true, latencies: [], tokens: { total: 1, input: 0, output: 1 }, scores: [score("refund")] },
      ],
      tokenUsage: { total: 1, input: 0, output: 1, perIteration: [] },
      latency: {
        e2e: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 1 },
        llm: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 1 },
        mcp: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 1 },
        perIteration: [],
      },
      evaluationConfig: buildEvaluationConfigSnapshot([GATING]),
    };
    const caseB = {
      ...caseA,
      iterationDetails: [
        { passed: true, latencies: [], tokens: { total: 1, input: 0, output: 1 }, scores: [score("refund"), score("tone", { value: 0.9 })] },
      ],
      evaluationConfig: buildEvaluationConfigSnapshot([GATING, JUDGE]),
    };

    const built = gateInputFromSuiteResult({
      tests: new Map([
        ["a", caseA],
        ["b", caseB],
      ]),
      aggregate: {
        iterations: 2,
        successes: 2,
        failures: 0,
        accuracy: 1,
        tokenUsage: { total: 2, perTest: [1, 1] },
        latency: {
          e2e: { min: 0, max: 0, mean: 0, p50: 0, p95: 3, count: 2 },
          llm: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 2 },
          mcp: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 2 },
        },
      },
    } as never);

    // `refund` appears in BOTH cases and collapses to one entry…
    expect(built.evaluationConfig?.definitions).toHaveLength(2);
    // …and the hash actually describes the merged set.
    expect(built.evaluationConfig?.hash).toBe(
      buildEvaluationConfigSnapshot([GATING, JUDGE]).hash
    );
    // Scores are flattened across every case.
    expect(built.scores).toHaveLength(3);

    // A policy naming a scorer that exists in only ONE case still resolves.
    expect(
      evaluateGates(built, { minimumScorerPassRate: { tone: 1 } }).outcome
    ).toBe("passed");
  });

  it("refuses to gate a scorerId two cases configured DIFFERENTLY", () => {
    // Merging across cases can put one id on two definitions — the same judge
    // graded at 0.7 in one case and 0.9 in another. Resolving to whichever
    // landed last would grade this run against a threshold nobody chose, and
    // pooling both cases' rows into one rate is a number with no meaning.
    const strict: ScoreDefinition = { ...JUDGE, passThreshold: 0.9 };
    const caseFor = (definition: ScoreDefinition) => ({
      iterations: 1,
      successes: 1,
      failures: 0,
      results: [true],
      iterationDetails: [
        {
          passed: true,
          latencies: [],
          tokens: { total: 1, input: 0, output: 1 },
          scores: [
            {
              ...score("tone", { value: 0.95 }),
              definitionHash: definitionHash(
                resolveScoreDefinition(definition)
              ),
            },
          ],
        },
      ],
      tokenUsage: { total: 1, input: 0, output: 1, perIteration: [] },
      latency: {
        e2e: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 1 },
        llm: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 1 },
        mcp: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 1 },
        perIteration: [],
      },
      evaluationConfig: buildEvaluationConfigSnapshot([definition]),
    });

    const built = gateInputFromSuiteResult({
      tests: new Map([
        ["a", caseFor(JUDGE)],
        ["b", caseFor(strict)],
      ]),
      aggregate: {
        iterations: 2,
        successes: 2,
        failures: 0,
        accuracy: 1,
        tokenUsage: { total: 2, perTest: [1, 1] },
        latency: {
          e2e: { min: 0, max: 0, mean: 0, p50: 0, p95: 3, count: 2 },
          llm: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 2 },
          mcp: { min: 0, max: 0, mean: 0, p50: 0, p95: 0, count: 2 },
        },
      },
    } as never);

    // Both survive the merge — they are genuinely different definitions.
    expect(built.evaluationConfig?.definitions).toHaveLength(2);

    const report = evaluateGates(built, { minimumScorerPassRate: { tone: 1 } });
    // A usage error, not `non_gateable`: nothing is missing or unverified, and
    // the fix is the author's.
    expect(report.outcome).toBe("usage_error");
    expect(report.verdicts[0].message).toMatch(/2 different definitions/);

    // …and the same ambiguity blocks a mean-score gate.
    expect(
      evaluateGates(built, { minimumMeanScore: { tone: 0.5 } }).outcome
    ).toBe("usage_error");
  });

  it("grades a scorer only on rows minted under ITS definition", () => {
    // A row carrying a known id but an unknown hash came from a different
    // configuration. Averaging it in would grade this run partly on another
    // one's evidence; it drops out, and a gate left with nothing says so.
    const stale = { ...score("refund", { passed: false, value: 0 }), definitionHash: "0".repeat(64) };
    expect(
      evaluateGates(input({ scores: [score("refund"), stale] }), {
        minimumScorerPassRate: { refund: 1 },
      }).outcome
    ).toBe("passed");
    expect(
      evaluateGates(input({ scores: [stale] }), {
        minimumScorerPassRate: { refund: 1 },
      }).outcome
    ).toBe("incomplete");
  });

  it("has no token total for an EMPTY iteration page, complete or not", () => {
    // `every` on an empty array is `true`: an empty-but-complete page would
    // otherwise sum to zero tokens and pass every cap ever written.
    const built = gateInputFromPlatformRun(
      {
        id: "run_1",
        suiteId: "s",
        runNumber: 1,
        status: "completed",
        result: "passed",
        summary: { total: 0, passed: 0 },
        source: "sdk",
        notes: null,
        createdAt: 0,
        completedAt: 1,
        scoreIntegrity: "valid",
      },
      { complete: true, items: [] }
    );
    expect(built.totals?.tokens).toBeUndefined();
    expect(
      evaluateGates(built, { maximumTotalTokens: 1 }).outcome
    ).toBe("incomplete");
  });

  it("drops the token total when ANY iteration lacks one", () => {
    const iteration = (tokensUsed: number | null) => ({
      id: "i",
      testCaseId: null,
      title: null,
      iterationNumber: 1,
      status: "completed",
      result: "passed",
      model: null,
      provider: null,
      startedAt: null,
      durationMs: 10,
      tokensUsed,
      usage: null,
      actualToolCalls: [],
      expectedToolCalls: [],
      error: null,
    });
    const run = {
      id: "run_1",
      suiteId: "s",
      runNumber: 1,
      status: "completed",
      result: "passed",
      summary: { total: 2, passed: 2 },
      source: "sdk",
      notes: null,
      createdAt: 0,
      completedAt: 1,
      scoreIntegrity: "valid" as const,
    };

    const complete = gateInputFromPlatformRun(run, {
      complete: true,
      items: [iteration(10), iteration(20)] as never,
    });
    expect(complete.totals?.tokens).toBe(30);
    expect(complete.totals?.e2eP95Ms).toBe(10);

    // One missing count makes the SUM wrong, not merely smaller.
    const partial = gateInputFromPlatformRun(run, {
      complete: true,
      items: [iteration(10), iteration(null)] as never,
    });
    expect(partial.totals?.tokens).toBeUndefined();
    expect(
      evaluateGates(partial, { maximumTotalTokens: 5 }).outcome
    ).toBe("incomplete");
  });

  it("maps a null platform integrity to undefined (no verdict)", () => {
    const built = gateInputFromPlatformRun({
      id: "run_1",
      suiteId: "s",
      runNumber: 1,
      status: "completed",
      result: "passed",
      summary: { total: 1, passed: 1 },
      source: "sdk",
      notes: null,
      createdAt: 0,
      completedAt: 1,
      scoreIntegrity: null,
    });
    expect(built.scoreIntegrity).toBeUndefined();
  });
});

describe("assertGate", () => {
  it("returns the report when everything passes", () => {
    expect(assertGate(input(), { minimumPassRate: 1 }).outcome).toBe("passed");
  });

  it("throws with the report attached on failure", () => {
    try {
      assertGate(input({ iterations: { total: 2, passed: 1 } }), {
        minimumPassRate: 1,
      });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GateError);
      expect((error as GateError).report.outcome).toBe("failed");
    }
  });

  it("throws on INCOMPLETE too — an undecided gate is not a satisfied one", () => {
    expect(() =>
      assertGate(input({ scoreIntegrity: undefined }), {
        minimumScorerPassRate: { refund: 1 },
      })
    ).toThrow(GateError);
  });
});

describe("gateOutcomeVerdict", () => {
  it("maps incomplete to inconclusive, never to failed", () => {
    // The case this guards: a renderer with no explicit verdict falls back
    // to reading `passed` (false for every non-"passed" outcome), which
    // would paint an unmeasured gate — a --wait timeout, a cancelled run,
    // non-gateable score integrity — the same red as a measured regression.
    expect(gateOutcomeVerdict("incomplete")).toBe("inconclusive");
  });

  it("maps passed to passed and failed/usage_error to failed", () => {
    expect(gateOutcomeVerdict("passed")).toBe("passed");
    expect(gateOutcomeVerdict("failed")).toBe("failed");
    expect(gateOutcomeVerdict("usage_error")).toBe("failed");
  });
});

describe("formatGateReport", () => {
  it("names the outcome and the integrity state", () => {
    const text = formatGateReport(
      evaluateGates(input({ scoreIntegrity: undefined }), {
        minimumScorerPassRate: { refund: 1 },
      })
    );
    expect(text).toContain("INCOMPLETE");
    expect(text).toContain("score integrity: unknown");
  });
});

// ── comparative fields in a single-run policy (Tranche 2) ──────────────────
//
// The failure mode this guards is quiet: a policy that says "fail on
// regressions", handed to an evaluator that cannot see a baseline, silently
// evaluating nothing and reporting green. CI would pass either way, which is
// exactly the state a gate exists to prevent. Every comparative field must be
// a loud usage error here.

describe("evaluateGates — comparative fields fail closed", () => {
  const COMPARATIVE_POLICIES: Array<{ label: string; policy: GatePolicy }> = [
    { label: "noDeterministicRegressions", policy: { noDeterministicRegressions: true } },
    { label: "maximumP95LatencyIncreaseMs", policy: { maximumP95LatencyIncreaseMs: 50 } },
    { label: "passRateRegression", policy: { passRateRegression: {} } },
  ];

  it.each(COMPARATIVE_POLICIES)(
    "$label is a usage error, never a silent no-op",
    ({ label, policy }) => {
      const report = evaluateGates(input({}), policy);
      expect(report.outcome).toBe("usage_error");
      const verdict = report.verdicts.find((row) => row.gate === label);
      expect(verdict?.status).toBe("usage_error");
      // Points at the surface that CAN answer it.
      expect(verdict?.message).toContain("mcpjam cloud eval compare");
    }
  );

  it("reports a comparative field even alongside a passing single-run gate", () => {
    const report = evaluateGates(input({}), {
      minimumPassRate: 0,
      noDeterministicRegressions: true,
    });
    // usage_error outranks everything: nothing this policy says can be trusted.
    expect(report.outcome).toBe("usage_error");
    expect(report.verdicts.map((verdict) => verdict.gate)).toContain(
      "minimumPassRate"
    );
  });

  it("covers every field listed in COMPARATIVE_GATE_FIELDS", () => {
    // Guards the guard: a new comparative field added to GatePolicy without a
    // fail-closed case here would leave this suite green while the hole is
    // open.
    expect([...COMPARATIVE_GATE_FIELDS].sort()).toEqual(
      COMPARATIVE_POLICIES.map((entry) => entry.label).sort()
    );
  });

  it("stays silent when no comparative field is present", () => {
    const report = evaluateGates(input({}), { minimumPassRate: 0 });
    expect(report.outcome).not.toBe("usage_error");
  });
});

describe("evaluateGates — an explicit false disables, it does not error", () => {
  it("treats `noDeterministicRegressions: false` as not-asked-for", () => {
    // Same semantics as `noGatingScoreErrors`. Erroring here would break every
    // caller that builds a policy object with all fields present.
    const report = evaluateGates(input({}), {
      minimumPassRate: 0,
      noDeterministicRegressions: false,
    });
    expect(report.outcome).not.toBe("usage_error");
    expect(report.verdicts.map((verdict) => verdict.gate)).not.toContain(
      "noDeterministicRegressions"
    );
  });

  it("but `maximumP95LatencyIncreaseMs: 0` is a REAL threshold, not a disable", () => {
    // 0 is falsy and would be skipped by a naive truthiness check — it means
    // "no latency increase at all is acceptable", the strictest setting.
    const report = evaluateGates(input({}), {
      maximumP95LatencyIncreaseMs: 0,
    });
    expect(report.outcome).toBe("usage_error");
  });

  it("the roster itself cannot be mutated to open a hole", () => {
    expect(Object.isFrozen(COMPARATIVE_GATE_FIELDS)).toBe(true);
  });
});
