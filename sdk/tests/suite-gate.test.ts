/**
 * Suite quality-gate contract — evaluator, fixtures, and flag-behavior pin.
 *
 * The fixture file is the shared corpus B1b will load. This file runs the
 * ACTUAL helpers (`evaluateSuiteGateEvidence`, `composeSuiteGateWithBaseReport`)
 * against every row. A second describe pins today's CLI flag path so adding
 * this contract cannot quietly rewrite `evaluateGates` / `evaluateCompareGates`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SUITE_GATE_CONDITION_REQUIRED_FIELDS,
  SUITE_GATE_EVALUATOR_VERSION,
  SUITE_GATE_SCHEMA_VERSION,
  composeSuiteGateWithBaseReport,
  evaluateSuiteGateEvidence,
  parseSuiteGatePolicyForAuthoring,
  parseSuiteGatePolicyForRead,
  suiteGatePolicyHash,
  type SuiteGateBaseReportInput,
  type SuiteGateConditionVerdictV1,
  type SuiteGateOutcomeV1,
  type SuiteGateReportV1,
} from "../src/contract/suite-gate.js";
import {
  COMPARATIVE_GATE_FIELDS,
  applyGateWaiver,
  evaluateGates,
  type GateInput,
  type GateScore,
  type GateWaiver,
} from "../src/gates.js";
import { evaluateCompareGates } from "../src/compare-gates.js";
import {
  buildEvaluationConfigSnapshot,
  definitionHash,
  resolveScoreDefinition,
} from "../src/contract/derive.js";
import type { ScoreDefinition } from "../src/contract/types.js";
import {
  comparePolicyFromGateOptions,
  policyFromOptions,
} from "../../cli/src/lib/eval-gate.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/gate-policy-parity-fixtures.json"
);

type EvaluateRow = {
  id: string;
  policy: unknown;
  evidence: unknown;
  expected: {
    outcome: SuiteGateOutcomeV1;
    conditions?: Array<
      Pick<
        SuiteGateConditionVerdictV1,
        "condition" | "status" | "reason" | "observed" | "threshold" | "scorerId"
      >
    >;
    policyError?: { reason: string };
  };
};

type ComposeRow = {
  id: string;
  base: SuiteGateBaseReportInput;
  suiteOutcome: SuiteGateOutcomeV1;
  applyWaiver?: boolean;
  expired?: boolean;
  expected: {
    outcome: string;
    baseOutcome?: string;
  };
};

const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  evaluate: EvaluateRow[];
  compose: ComposeRow[];
};

const NOW = 1_700_000_000_000;
const WAIVER: GateWaiver = {
  id: "wv_1",
  reason: "hotfix ships today",
  expiresAt: NOW + 86_400_000,
  createdAt: NOW - 3_600_000,
  createdBy: "usr_1",
  createdByEmail: "alice@example.com",
  policySnapshot: { minimumPassRate: 1 },
};

function suiteReport(outcome: SuiteGateOutcomeV1): SuiteGateReportV1 {
  const policy = outcome === "not_configured" ? {} : { noGatingScoreErrors: true };
  return {
    schemaVersion: SUITE_GATE_SCHEMA_VERSION,
    evaluatorVersion: SUITE_GATE_EVALUATOR_VERSION,
    policy,
    policyHash: suiteGatePolicyHash(policy),
    outcome,
    conditions:
      outcome === "not_configured"
        ? []
        : [
            {
              condition: "noGatingScoreErrors",
              status:
                outcome === "failed"
                  ? "failed"
                  : outcome === "non_gateable"
                    ? "non_gateable"
                    : "passed",
              message: "fixture",
              ...(outcome === "non_gateable"
                ? { reason: "INTEGRITY_UNVERIFIED" as const }
                : {}),
            },
          ],
  };
}

function pickCondition(row: SuiteGateConditionVerdictV1) {
  return {
    condition: row.condition,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.observed !== undefined ? { observed: row.observed } : {}),
    ...(row.threshold !== undefined ? { threshold: row.threshold } : {}),
    ...(row.scorerId ? { scorerId: row.scorerId } : {}),
  };
}

describe("gate-policy fixtures — evaluateSuiteGateEvidence", () => {
  it("covers every required cohort", () => {
    const ids = new Set(fixtures.evaluate.map((row) => row.id));
    for (const required of [
      "no-conditions",
      "baseline-only",
      "absolute-only-pass",
      "absolute-only-error",
      "absolute-only-unknown-integrity",
      "numeric-zero-drop-is-active",
      "drop-equality-passes",
      "drop-over-threshold-fails",
      "scorer-added",
      "scorer-removed",
      "scorer-changed",
      "generated-id-blocks-drop",
      "absolute-generated-id-still-inspected",
      "quarantined-population",
      "configured-weights-mismatch",
      "observed-weights-mismatch",
      "missing-latency",
      "incomplete-capture",
      "mixed-failed-and-non-gateable",
    ]) {
      expect(ids.has(required), required).toBe(true);
    }
    expect(fixtures.compose.length).toBeGreaterThan(20);
  });

  for (const row of fixtures.evaluate) {
    it(row.id, () => {
      const report = evaluateSuiteGateEvidence({
        policy: row.policy,
        evidence: row.evidence,
      });
      expect(report.schemaVersion).toBe(SUITE_GATE_SCHEMA_VERSION);
      expect(report.evaluatorVersion).toBe(SUITE_GATE_EVALUATOR_VERSION);
      expect(report.outcome).toBe(row.expected.outcome);
      if (row.expected.policyError) {
        expect(report.policyError?.reason).toBe(row.expected.policyError.reason);
        return;
      }
      const parsed = parseSuiteGatePolicyForRead(row.policy);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(report.policy).toEqual(parsed.policy);
        expect(report.policyHash).toBe(parsed.hash);
      }
      expect((report.conditions ?? []).map(pickCondition)).toEqual(
        row.expected.conditions ?? []
      );
    });
  }
});

describe("gate-policy fixtures — composeSuiteGateWithBaseReport", () => {
  for (const row of fixtures.compose) {
    it(row.id, () => {
      const composed = composeSuiteGateWithBaseReport({
        base: row.base,
        suite: suiteReport(row.suiteOutcome),
        waiver: row.applyWaiver
          ? {
              ...WAIVER,
              expiresAt: row.expired ? NOW - 1 : WAIVER.expiresAt,
            }
          : undefined,
        now: NOW,
      });
      expect(composed.outcome).toBe(row.expected.outcome);
      if (row.expected.baseOutcome) {
        expect(composed.base.outcome).toBe(row.expected.baseOutcome);
      }
      expect(composed.suite.outcome).toBe(row.suiteOutcome);
      if (composed.base.waiver) {
        expect(composed.suite).not.toHaveProperty("waiver");
      }
    });
  }

  it("applies the same waiver rules as applyGateWaiver on the base half", () => {
    const failedBase = {
      outcome: "failed" as const,
      verdicts: [
        { gate: "minimumPassRate", status: "failed" as const, message: "missed" },
      ],
      scoreIntegrity: "valid" as const,
    };
    const sdk = applyGateWaiver(failedBase, WAIVER, NOW);
    const composed = composeSuiteGateWithBaseReport({
      base: { outcome: "failed" },
      suite: suiteReport("not_configured"),
      waiver: WAIVER,
      now: NOW,
    });
    expect(sdk.outcome).toBe("waived");
    expect(composed.base.outcome).toBe("waived");
    expect(composed.outcome).toBe("waived");
  });
});

describe("suite-gate authoring vs read", () => {
  it("rejects previous_completed on authoring writes", () => {
    const parsed = parseSuiteGatePolicyForAuthoring({
      baseline: { kind: "previous_completed" },
      maximumPassRateDrop: 0.03,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("PREVIOUS_COMPLETED_UNSUPPORTED");
    }
  });

  it("rejects comparative conditions without a selector on authoring", () => {
    const parsed = parseSuiteGatePolicyForAuthoring({
      maximumPassRateDrop: 0,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe("COMPARATIVE_WITHOUT_BASELINE");
    }
  });

  it("accepts absolute-only authoring and keeps numeric zero", () => {
    const parsed = parseSuiteGatePolicyForAuthoring({
      noGatingScoreErrors: true,
      noDeterministicRegressions: false,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.policy).toEqual({ noGatingScoreErrors: true });
    }
  });

  it("reads a reserved previous_completed policy instead of dropping it", () => {
    const parsed = parseSuiteGatePolicyForRead({
      baseline: { kind: "previous_completed" },
      maximumPassRateDrop: 0.03,
    });
    expect(parsed.ok).toBe(true);
  });

  it("names the evidence fields each condition requires", () => {
    expect(SUITE_GATE_CONDITION_REQUIRED_FIELDS.noGatingScoreErrors).toContain(
      "subject.scores"
    );
    expect(
      SUITE_GATE_CONDITION_REQUIRED_FIELDS.maximumPassRateDrop
    ).toContain("baseline.resolved");
  });
});

describe("CLI flag behavior remains pinned", () => {
  const GATING: ScoreDefinition = {
    scorerId: "refund",
    idSource: "explicit",
    scorerVersion: "1",
    implementationHash: "impl-refund",
    deterministic: true,
    passThreshold: 1,
    role: "gating",
  };
  const snapshot = buildEvaluationConfigSnapshot([GATING]);
  const refundHash = definitionHash(resolveScoreDefinition(GATING));
  const score = (over: Partial<GateScore> = {}): GateScore => ({
    scorerId: "refund",
    definitionHash: refundHash,
    status: "scored",
    value: 1,
    passed: true,
    ...over,
  });
  const input = (over: Partial<GateInput> = {}): GateInput => ({
    iterations: { total: 10, passed: 10 },
    evaluationConfig: snapshot,
    scores: [score()],
    scoreIntegrity: "valid",
    totals: { tokens: 1000, e2eP95Ms: 500 },
    ...over,
  });

  it("policyFromOptions still converts percent at the CLI boundary", () => {
    expect(
      policyFromOptions({ minPassRatePercent: "100" }).minimumPassRate
    ).toBe(1);
    expect(
      policyFromOptions({ minPassRatePercent: "3" }).minimumPassRate
    ).toBe(0.03);
  });

  it("comparePolicyFromGateOptions still requires a baseline for comparative flags", () => {
    expect(() =>
      comparePolicyFromGateOptions({
        gateDeterministicRegressions: true,
      })
    ).toThrow(/baseline/);
    const withBaseline = comparePolicyFromGateOptions({
      baseline: "run_base",
      gateDeterministicRegressions: true,
      maxP95LatencyIncreaseMs: "25",
    });
    expect(withBaseline.noDeterministicRegressions).toBe(true);
    expect(withBaseline.maximumP95LatencyIncreaseMs).toBe(25);
    expect(withBaseline.passRateRegression).toEqual({});
    expect(withBaseline).not.toHaveProperty("maximumPassRateDrop");
  });

  it("evaluateGates still refuses comparative fields as usage errors", () => {
    for (const field of COMPARATIVE_GATE_FIELDS) {
      const policy =
        field === "passRateRegression"
          ? { passRateRegression: {} }
          : field === "maximumP95LatencyIncreaseMs"
            ? { maximumP95LatencyIncreaseMs: 0 }
            : { noDeterministicRegressions: true };
      const report = evaluateGates(input(), policy);
      expect(report.outcome, field).toBe("usage_error");
    }
  });

  it("evaluateGates noGatingScoreErrors still ignores advisory errors", () => {
    const advisory = resolveScoreDefinition({
      scorerId: "style",
      idSource: "explicit",
      scorerVersion: "1",
      implementationHash: "impl-style",
      deterministic: false,
      passThreshold: 0.5,
      role: "advisory",
    });
    const mixed = buildEvaluationConfigSnapshot([GATING, advisory]);
    const report = evaluateGates(
      input({
        evaluationConfig: mixed,
        scores: [
          score(),
          {
            scorerId: "style",
            definitionHash: definitionHash(advisory),
            status: "error",
          },
        ],
      }),
      { noGatingScoreErrors: true }
    );
    expect(report.outcome).toBe("passed");
  });

  it("evaluateCompareGates still uses the statistical pass-rate test, not a drop fraction", () => {
    const report = evaluateCompareGates(
      {
        base: {
          iterations: { passed: 8, total: 10 },
          scoreIntegrity: "valid",
        },
        compare: {
          iterations: { passed: 7, total: 10 },
          scoreIntegrity: "valid",
        },
        deterministicScoreRegressions: [],
        scoreDeltasAvailable: true,
        caseSetChanged: false,
        scenarioConfigChanged: false,
        evaluationConfigChanged: false,
        iterationWeightingEqual: true,
      },
      { passRateRegression: {} }
    );
    expect(report.outcome).toBe("passed");
    expect(report.verdicts[0]?.gate).toBe("passRateRegression");
  });

  it("suite-gate noGatingScoreErrors agrees with evaluateGates on the same scores", () => {
    const errored = input({
      scores: [score({ status: "error", value: undefined, passed: undefined })],
    });
    const flag = evaluateGates(errored, { noGatingScoreErrors: true });
    const suite = evaluateSuiteGateEvidence({
      policy: { noGatingScoreErrors: true },
      evidence: {
        subject: {
          runId: "run_subject",
          final: true,
          scoreIntegrity: "valid",
          captureComplete: true,
          evaluationConfig: {
            definitions: snapshot.definitions,
          },
          scores: errored.scores?.map((row) => ({
            scorerId: row.scorerId,
            definitionHash: row.definitionHash,
            status: row.status,
            ...(row.passed !== undefined ? { passed: row.passed } : {}),
          })),
        },
      },
    });
    expect(flag.outcome).toBe("failed");
    expect(suite.outcome).toBe("failed");
  });
});
