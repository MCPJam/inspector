/**
 * Gate-report parity across the `dual_write` flip — promotion gate (e).
 *
 * `evaluateGates` fails OPEN when a run carries no definition snapshot
 * (`src/gates.ts`, the `hasSnapshot` guard): every score-shaped policy on a
 * hosted run is a silent `non_gateable` today. `dual_write` gives those runs
 * rows and definitions, so the same policy STARTS DECIDING — on an operator
 * flag flip, in a customer's CI. This harness pins where that can and cannot
 * happen, so the flip is reviewed rather than discovered.
 *
 * Three findings, each asserted below:
 *   1. Rows alone change NOTHING: `scoreIntegrity` is a separate tri-state, and
 *      a hosted run without an integrity verdict stays non-gateable with a full
 *      score contract attached. That is the real blast-radius answer.
 *   2. Rows plus `scoreIntegrity: "valid"` DO flip score gates from
 *      `non_gateable` to `passed`/`failed`. Non-score gates are untouched.
 *   3. An advisory judge row never participates, even when it errors or fails.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateGates,
  gateInputFromPlatformRun,
  type GatePolicy,
  type GateReport,
} from "../src/gates.js";
import {
  definitionHash,
  evaluationConfigHash,
  resolveScoreDefinition,
} from "../src/contract/derive.js";
import type {
  EvaluationConfigSnapshot,
  ResolvedScoreDefinition,
  ScoreResult,
} from "../src/contract/types.js";
import type {
  PlatformEvalIteration,
  PlatformEvalRun,
} from "../src/platform/types.js";

// ── the hosted score contract `dual_write` starts writing ──────────────────
//
// Shaped like `server/services/evals/score-definitions.ts` in the inspector:
// two deterministic gating scorers and one advisory judge.

const predicateDefinition: ResolvedScoreDefinition = resolveScoreDefinition({
  scorerId: "predicate:contains-1f0a9c",
  idSource: "platform",
  scorerVersion: "1",
  implementationHash: "a".repeat(64),
  deterministic: true,
  passThreshold: 1,
  role: "gating",
});

const toolMatchDefinition: ResolvedScoreDefinition = resolveScoreDefinition({
  scorerId: "toolCalls:match",
  idSource: "platform",
  scorerVersion: "1",
  implementationHash: "b".repeat(64),
  deterministic: true,
  passThreshold: 1,
  role: "gating",
});

const judgeDefinition: ResolvedScoreDefinition = resolveScoreDefinition({
  scorerId: "judge:goalCompletion",
  idSource: "platform",
  scorerVersion: "1",
  implementationHash: "c".repeat(64),
  deterministic: false,
  passThreshold: 0.7,
  role: "advisory",
});

const definitions = [
  predicateDefinition,
  toolMatchDefinition,
  judgeDefinition,
];

const evaluationConfig: EvaluationConfigSnapshot = {
  hash: evaluationConfigHash(definitions),
  definitions,
};

function row(
  definition: ResolvedScoreDefinition,
  outcome:
    | { status: "scored"; value: number }
    | { status: "error" }
    | { status: "skipped" }
): ScoreResult {
  const base = {
    scorerId: definition.scorerId,
    scorerVersion: definition.scorerVersion,
    definitionHash: definitionHash(definition),
    passThreshold: definition.passThreshold,
    deterministic: definition.deterministic,
  };
  if (outcome.status === "scored") {
    return {
      ...base,
      status: "scored",
      value: outcome.value,
      passed: outcome.value >= definition.passThreshold,
    };
  }
  if (outcome.status === "error") {
    return { ...base, status: "error", error: "scorer threw" };
  }
  return { ...base, status: "skipped" };
}

// ── the run ────────────────────────────────────────────────────────────────

function iteration(
  id: string,
  passed: boolean,
  scores?: ScoreResult[]
): PlatformEvalIteration {
  return {
    id,
    testCaseId: `case-${id}`,
    title: null,
    iterationNumber: 1,
    status: "completed",
    result: passed ? "passed" : "failed",
    model: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    startedAt: 1,
    durationMs: 1_000,
    tokensUsed: 100,
    usage: null,
    actualToolCalls: [],
    expectedToolCalls: [],
    error: null,
    ...(scores ? { scores, evaluationConfig } : {}),
  };
}

function run(
  overrides: Partial<PlatformEvalRun> = {}
): PlatformEvalRun {
  return {
    id: "run-1",
    suiteId: "suite-1",
    runNumber: 7,
    status: "completed",
    result: "failed",
    summary: { total: 4, passed: 3, failed: 1, passRate: 0.75 },
    source: "ui",
    notes: null,
    createdAt: 1,
    completedAt: 2,
    ...overrides,
  };
}

/** The score contract of one passing and one failing iteration. */
const passingScores = [
  row(predicateDefinition, { status: "scored", value: 1 }),
  row(toolMatchDefinition, { status: "scored", value: 1 }),
  row(judgeDefinition, { status: "scored", value: 0.9 }),
];
const failingScores = [
  row(predicateDefinition, { status: "scored", value: 0 }),
  row(toolMatchDefinition, { status: "scored", value: 1 }),
  row(judgeDefinition, { status: "scored", value: 0.4 }),
];

/** The four iterations of the run, before and after `dual_write`. */
const before: PlatformEvalIteration[] = [
  iteration("i1", true),
  iteration("i2", true),
  iteration("i3", true),
  iteration("i4", false),
];
const after: PlatformEvalIteration[] = [
  iteration("i1", true, passingScores),
  iteration("i2", true, passingScores),
  iteration("i3", true, passingScores),
  iteration("i4", false, failingScores),
];

/**
 * A policy that asks every question a hosted run can be asked, so a difference
 * anywhere shows up as a difference in this one report.
 */
const policy: GatePolicy = {
  minimumPassRate: 0.5,
  maximumTotalTokens: 10_000,
  maximumP95LatencyMs: 5_000,
  noGatingScoreErrors: true,
  minimumScorerPassRate: { "toolCalls:match": 1 },
  minimumMeanScore: { "predicate:contains-1f0a9c": 0.5 },
};

function statuses(report: GateReport): Record<string, string> {
  return Object.fromEntries(
    report.verdicts.map((verdict) => [verdict.gate, verdict.status])
  );
}

function reportFor(
  items: PlatformEvalIteration[],
  runOverrides: Partial<PlatformEvalRun> = {},
  gatePolicy: GatePolicy = policy
): GateReport {
  return evaluateGates(
    gateInputFromPlatformRun(run(runOverrides), { items, complete: true }),
    gatePolicy
  );
}

describe("gate parity across the dual_write flip", () => {
  it("rows WITHOUT an integrity verdict change nothing — the report is identical", () => {
    // The state a hosted run is in the moment the flag flips, before any
    // backend integrity stamping: full score contract, no verdict on it.
    const legacy = reportFor(before);
    const dualWrite = reportFor(after);

    // Every gate's STATUS is identical, and the outcome with it. The only
    // difference is the explanation a non-gateable score gate gives: before,
    // "no evaluation config"; after, "no score-integrity verdict". The run
    // gained definitions and stayed undecidable, which is the point.
    expect(statuses(dualWrite)).toEqual(statuses(legacy));
    expect(dualWrite.outcome).toBe(legacy.outcome);
    expect(
      legacy.verdicts.find((v) => v.gate === "noGatingScoreErrors")?.message
    ).toContain("no evaluation config");
    expect(
      dualWrite.verdicts.find((v) => v.gate === "noGatingScoreErrors")?.message
    ).toContain("no score-integrity verdict");
    expect(dualWrite.scoreIntegrity).toBe("unknown");
    expect(statuses(dualWrite)).toEqual({
      minimumPassRate: "passed",
      maximumTotalTokens: "passed",
      maximumP95LatencyMs: "passed",
      noGatingScoreErrors: "non_gateable",
      "minimumScorerPassRate:toolCalls:match": "non_gateable",
      "minimumMeanScore:predicate:contains-1f0a9c": "non_gateable",
    });
  });

  it("rows PLUS a valid integrity verdict flip score gates from non_gateable to decided", () => {
    const legacy = reportFor(before, { scoreIntegrity: "valid" });
    const dualWrite = reportFor(after, { scoreIntegrity: "valid" });

    // Every difference, enumerated. The three score gates go from "we
    // established nothing" to decided; the three non-score gates do not move.
    // A score gate can also start FAILING a run — the next test pins that.
    expect(statuses(legacy)).toEqual({
      minimumPassRate: "passed",
      maximumTotalTokens: "passed",
      maximumP95LatencyMs: "passed",
      noGatingScoreErrors: "non_gateable",
      "minimumScorerPassRate:toolCalls:match": "non_gateable",
      "minimumMeanScore:predicate:contains-1f0a9c": "non_gateable",
    });
    expect(statuses(dualWrite)).toEqual({
      // unchanged — not score-derived
      minimumPassRate: "passed",
      maximumTotalTokens: "passed",
      maximumP95LatencyMs: "passed",
      // CHANGED: no gating scorer errored, so this is now an answered question
      noGatingScoreErrors: "passed",
      // CHANGED: tool matching passed on all four iterations
      "minimumScorerPassRate:toolCalls:match": "passed",
      // CHANGED: mean predicate value is 0.75 >= 0.5
      "minimumMeanScore:predicate:contains-1f0a9c": "passed",
    });

    // The outcome itself moves from incomplete to passed: that is the flip a
    // customer sees, and it is why promotion needs this harness green first.
    expect(legacy.outcome).toBe("incomplete");
    expect(dualWrite.outcome).toBe("passed");
  });

  it("a score gate can now FAIL a run the legacy report called incomplete", () => {
    const strict: GatePolicy = {
      minimumScorerPassRate: { "predicate:contains-1f0a9c": 1 },
    };
    expect(
      statuses(reportFor(before, { scoreIntegrity: "valid" }, strict))
    ).toEqual({
      "minimumScorerPassRate:predicate:contains-1f0a9c": "non_gateable",
    });
    expect(
      statuses(reportFor(after, { scoreIntegrity: "valid" }, strict))
    ).toEqual({
      "minimumScorerPassRate:predicate:contains-1f0a9c": "failed",
    });
  });

  it("an advisory judge row never gates — not when it fails, not when it errors", () => {
    const judgeErrored = after.map((item) =>
      item.scores
        ? {
            ...item,
            scores: [
              row(predicateDefinition, { status: "scored", value: 1 }),
              row(toolMatchDefinition, { status: "scored", value: 1 }),
              row(judgeDefinition, { status: "error" }),
            ],
          }
        : item
    );

    // `noGatingScoreErrors` still passes: the only error is advisory.
    expect(
      statuses(reportFor(judgeErrored, { scoreIntegrity: "valid" }))
    ).toMatchObject({ noGatingScoreErrors: "passed" });

    // And naming the judge in a policy is a USAGE error's opposite — it is
    // allowed, but it only ever describes the judge, never the run's verdict.
    const judgePolicy: GatePolicy = {
      minimumScorerPassRate: { "judge:goalCompletion": 1 },
    };
    const withFailingJudge = reportFor(
      after,
      { scoreIntegrity: "valid" },
      judgePolicy
    );
    expect(statuses(withFailingJudge)).toEqual({
      "minimumScorerPassRate:judge:goalCompletion": "failed",
    });
    // The advisory row is only consulted because the AUTHOR asked for it by id.
    // Nothing in the default policy set above reaches it.
    expect(
      statuses(reportFor(after, { scoreIntegrity: "valid" }))
    ).not.toHaveProperty("minimumScorerPassRate:judge:goalCompletion");
  });

  it("run-level scoreIntegrity: 'invalid' makes score gates non-gateable — INTENDED", () => {
    // Not a regression and not a bug to route around: the backend downgraded
    // this run's score evidence at ingest, so a green score gate on it would be
    // green on evidence that did not verify.
    const report = reportFor(after, { scoreIntegrity: "invalid" });
    expect(report.scoreIntegrity).toBe("invalid");
    expect(statuses(report)).toEqual({
      minimumPassRate: "passed",
      maximumTotalTokens: "passed",
      maximumP95LatencyMs: "passed",
      noGatingScoreErrors: "non_gateable",
      "minimumScorerPassRate:toolCalls:match": "non_gateable",
      "minimumMeanScore:predicate:contains-1f0a9c": "non_gateable",
    });
    expect(report.outcome).toBe("incomplete");
    for (const verdict of report.verdicts) {
      if (verdict.status !== "non_gateable") continue;
      expect(verdict.message).toContain("did not verify");
    }
  });

  it("an incomplete iterations page never gates, with or without rows", () => {
    const partial = evaluateGates(
      gateInputFromPlatformRun(run({ scoreIntegrity: "valid" }), {
        items: after.slice(0, 2),
        complete: false,
      }),
      policy
    );
    expect(statuses(partial)).toMatchObject({
      maximumTotalTokens: "non_gateable",
      noGatingScoreErrors: "non_gateable",
    });
  });
});
