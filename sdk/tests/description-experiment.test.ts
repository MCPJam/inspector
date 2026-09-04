/**
 * `DescriptionExperimentReport` — the report-only rewrite comparison.
 *
 * Organised around the ways this view LIES:
 *
 *   - a number when either arm is below the minimum;
 *   - a Wald collapse at all-pass / all-fail;
 *   - a rewrite trial counted when the override was not applied;
 *   - a non-affected case flip buried under "no difference";
 *   - a Controlled label without a per-trial sandbox reset.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  DESCRIPTION_EXPERIMENT_ARMS,
  DESCRIPTION_EXPERIMENT_EVIDENCE_LABELS,
  DESCRIPTION_EXPERIMENT_EXCLUSION_REASONS,
  DESCRIPTION_EXPERIMENT_SCHEMA_VERSION,
  buildDescriptionExperimentReport,
  classifyDescriptionExperimentTrial,
  descriptionExperimentReportSchema,
  diffDescriptionWords,
  isDescriptionExperimentArm,
  isDescriptionExperimentEvidenceLabel,
  isDescriptionExperimentExclusionReason,
  type DescriptionExperimentArmInput,
  type DescriptionExperimentFrozen,
  type DescriptionExperimentReportInput,
  type DescriptionExperimentTrialInput,
} from "../src/contract/index.js";
import { newcombeDifferenceInterval } from "../src/compare-stats.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "description-experiment-fixtures.json"
);

type FixtureRow = Record<string, unknown> & {
  __label: string;
  __why?: string;
};

type DescriptionExperimentFixtures = {
  accept: FixtureRow[];
  reject: FixtureRow[];
  roundTrip: FixtureRow[];
};

function stripAnnotations<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripAnnotations(entry)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (key.startsWith("__")) continue;
      out[key] = stripAnnotations(entry);
    }
    return out as unknown as T;
  }
  return value;
}

const fixtures = JSON.parse(
  readFileSync(FIXTURE_PATH, "utf8")
) as DescriptionExperimentFixtures;

const trial = (
  over: Partial<DescriptionExperimentTrialInput> & {
    trialKey: string;
    aggregationKey?: string;
  }
): DescriptionExperimentTrialInput => ({
  status: "completed",
  result: "passed",
  aggregationKey: over.aggregationKey ?? "case_a\u0000",
  metadata: { descriptionExperiment: { applied: true } },
  ...over,
});

const nTrials = (
  count: number,
  result: "passed" | "failed",
  prefix: string,
  extra: Partial<DescriptionExperimentTrialInput> = {}
): DescriptionExperimentTrialInput[] =>
  Array.from({ length: count }, (_, index) =>
    trial({
      trialKey: `${prefix}_${index}`,
      result,
      ...extra,
    })
  );

const frozen = (
  over: Partial<DescriptionExperimentFrozen> = {}
): DescriptionExperimentFrozen => ({
  model: ["anthropic/claude-haiku-4.5"],
  engine: "emulated",
  environmentReset: "none",
  ...over,
});

const build = (
  over: Partial<DescriptionExperimentReportInput> & {
    original: DescriptionExperimentArmInput;
    rewrite: DescriptionExperimentArmInput;
  }
) =>
  buildDescriptionExperimentReport({
    toolName: "tool_a",
    affectedAggregationKeys: ["case_a\u0000"],
    assignment: { method: "concurrent_two_run", overlapVerified: false },
    frozen: frozen(),
    ...over,
  });

describe("closed vocabularies", () => {
  test("arms, exclusions and labels have guards", () => {
    expect(DESCRIPTION_EXPERIMENT_ARMS).toEqual(["original", "rewrite"]);
    expect(isDescriptionExperimentArm("rewrite")).toBe(true);
    expect(isDescriptionExperimentArm("control")).toBe(false);
    expect(DESCRIPTION_EXPERIMENT_EXCLUSION_REASONS).toEqual([
      "notTerminal",
      "errored",
      "timedOut",
      "negativeTest",
      "overrideNotApplied",
      "unsupportedEngine",
    ]);
    expect(isDescriptionExperimentExclusionReason("overrideNotApplied")).toBe(
      true
    );
    expect(isDescriptionExperimentExclusionReason("skipped")).toBe(false);
    expect(DESCRIPTION_EXPERIMENT_EVIDENCE_LABELS).toEqual([
      "controlled",
      "reproducible",
    ]);
    expect(isDescriptionExperimentEvidenceLabel("controlled")).toBe(true);
    expect(DESCRIPTION_EXPERIMENT_SCHEMA_VERSION).toBe(1);
  });
});

describe("fixture cohorts", () => {
  test.each(fixtures.accept)("accept: $__label", (row) => {
    const parsed = descriptionExperimentReportSchema.safeParse(
      stripAnnotations(row)
    );
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(
      true
    );
  });

  test.each(fixtures.reject)("reject: $__label", (row) => {
    const parsed = descriptionExperimentReportSchema.safeParse(
      stripAnnotations(row)
    );
    expect(parsed.success).toBe(false);
  });

  test.each(fixtures.roundTrip)("roundTrip: $__label", (row) => {
    const cleaned = stripAnnotations(row);
    const parsed = descriptionExperimentReportSchema.parse(cleaned);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(cleaned);
  });
});

describe("classifyDescriptionExperimentTrial", () => {
  test("rewrite arm requires the applied marker", () => {
    expect(
      classifyDescriptionExperimentTrial(
        trial({ trialKey: "t1", metadata: {} }),
        "rewrite"
      )
    ).toBe("overrideNotApplied");
    expect(
      classifyDescriptionExperimentTrial(
        trial({
          trialKey: "t2",
          metadata: { descriptionExperiment: { applied: true } },
        }),
        "rewrite"
      )
    ).toBeUndefined();
    expect(
      classifyDescriptionExperimentTrial(
        trial({ trialKey: "t3", metadata: {} }),
        "original"
      )
    ).toBeUndefined();
  });

  test("lifecycle and engine exclusions win over the applied marker", () => {
    expect(
      classifyDescriptionExperimentTrial(
        trial({ trialKey: "t1", status: "running", engineSupported: false }),
        "rewrite"
      )
    ).toBe("unsupportedEngine");
    expect(
      classifyDescriptionExperimentTrial(
        trial({ trialKey: "t2", status: "timed_out" }),
        "rewrite"
      )
    ).toBe("timedOut");
    expect(
      classifyDescriptionExperimentTrial(
        trial({ trialKey: "t3", status: "failed" }),
        "original"
      )
    ).toBe("errored");
    expect(
      classifyDescriptionExperimentTrial(
        trial({ trialKey: "t4", isNegativeTest: true }),
        "original"
      )
    ).toBe("negativeTest");
  });
});

describe("buildDescriptionExperimentReport", () => {
  test("below-minimum arms ⇒ interval null, insufficient_data", () => {
    const report = build({
      original: { trials: nTrials(3, "passed", "o") },
      rewrite: { trials: nTrials(3, "failed", "r") },
    });
    expect(report.primary.pooled.interval).toBeNull();
    expect(report.primary.pooled.verdict).toBe("insufficient_data");
    expect(report.primary.pooled.minSampleSize).toBe(5);
    expect(report.primary.perCase[0]?.interval).toBeNull();
    expect(report.primary.perCase[0]?.verdict).toBe("insufficient_data");
  });

  test("all-pass / all-fail Wilson edge keeps a non-degenerate interval", () => {
    const report = build({
      original: { trials: nTrials(10, "failed", "o") },
      rewrite: { trials: nTrials(10, "passed", "r") },
    });
    const expected = newcombeDifferenceInterval({
      base: { passed: 0, total: 10 },
      compare: { passed: 10, total: 10 },
    });
    expect(report.primary.pooled.interval).toEqual({
      deltaPoints: expected.delta * 100,
      lowerPoints: expected.lower * 100,
      upperPoints: expected.upper * 100,
    });
    expect(report.primary.pooled.interval!.lowerPoints).toBeGreaterThan(0);
    expect(report.primary.pooled.interval!.upperPoints).toBeLessThanOrEqual(100);
    expect(report.primary.pooled.verdict).toBe("improved");
  });

  test("overrideNotApplied drops rewrite trials from the eligible set", () => {
    const report = build({
      original: { trials: nTrials(8, "passed", "o") },
      rewrite: {
        trials: [
          ...nTrials(5, "passed", "applied"),
          ...nTrials(5, "passed", "missing", { metadata: {} }),
        ],
      },
    });
    expect(report.primary.pooled.rewrite.eligible).toBe(5);
    expect(report.primary.pooled.rewrite.exclusions.overrideNotApplied).toBe(5);
    expect(report.primary.pooled.original.eligible).toBe(8);
  });

  test("regression flip on a non-affected case ⇒ failed", () => {
    const report = build({
      original: { trials: nTrials(5, "passed", "o") },
      rewrite: { trials: nTrials(5, "passed", "r") },
      otherCaseFlips: [
        {
          aggregationKey: "other\u0000",
          originalStatus: "passed",
          rewriteStatus: "failed",
        },
      ],
    });
    expect(report.regression).toEqual({
      checked: true,
      otherCases: 1,
      regressed: ["other\u0000"],
      status: "failed",
    });
  });

  test("unchecked other cases are non_gateable", () => {
    const report = build({
      original: { trials: nTrials(5, "passed", "o") },
      rewrite: { trials: nTrials(5, "passed", "r") },
    });
    expect(report.regression.checked).toBe(false);
    expect(report.regression.status).toBe("non_gateable");
    expect(report.regression.reason).toMatch(/not replayed/);
  });

  test("evidenceLabel is controlled only with sandbox reset AND overlap", () => {
    const reproducible = build({
      original: { trials: nTrials(5, "passed", "o") },
      rewrite: { trials: nTrials(5, "passed", "r") },
      frozen: frozen({ environmentReset: "per_trial_sandbox" }),
      assignment: { method: "concurrent_two_run", overlapVerified: false },
    });
    expect(reproducible.evidenceLabel).toBe("reproducible");

    const alsoReproducible = build({
      original: { trials: nTrials(5, "passed", "o") },
      rewrite: { trials: nTrials(5, "passed", "r") },
      frozen: frozen({ environmentReset: "none" }),
      assignment: { method: "concurrent_two_run", overlapVerified: true },
    });
    expect(alsoReproducible.evidenceLabel).toBe("reproducible");

    const controlled = build({
      original: { trials: nTrials(5, "passed", "o") },
      rewrite: { trials: nTrials(5, "passed", "r") },
      frozen: frozen({ environmentReset: "per_trial_sandbox" }),
      assignment: { method: "concurrent_two_run", overlapVerified: true },
    });
    expect(controlled.evidenceLabel).toBe("controlled");
  });

  test("reportOnly is the literal true and the document parses", () => {
    const report = build({
      original: { trials: nTrials(8, "passed", "o") },
      rewrite: { trials: nTrials(9, "passed", "r").concat(nTrials(1, "failed", "rf")) },
    });
    expect(report.reportOnly).toBe(true);
    expect(report.population).toBe("trial");
    expect(descriptionExperimentReportSchema.parse(report)).toEqual(report);
  });
});

describe("diffDescriptionWords", () => {
  test("returns added and removed words via LCS", () => {
    const diff = diffDescriptionWords(
      "Look up a user by id",
      "Look up a user by email or id"
    );
    expect(diff.added).toEqual(["email", "or"]);
    expect(diff.removed).toEqual([]);
    expect(diff.tokens.map((token) => token.type)).toContain("add");
  });

  test("records deletions", () => {
    const diff = diffDescriptionWords(
      "Search users then get the profile",
      "Search users"
    );
    expect(diff.removed).toEqual(["then", "get", "the", "profile"]);
    expect(diff.added).toEqual([]);
  });
});
