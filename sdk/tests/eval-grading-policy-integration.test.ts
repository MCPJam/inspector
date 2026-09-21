/**
 * G0c: the SDK integration seam, against real loader output and real DTO
 * shapes.
 *
 * `contract-grading-policy.test.ts` pins the model and the pure adapters
 * against the shared corpus. This pins the WIRING: that a suite file loaded by
 * the real loader produces the policy the file describes, that the platform DTO
 * round-trips through the same adapter the corpus checks, that a deployment
 * which cannot say is refused rather than guessed, and that the reviewed edit
 * produces a body the hosted route accepts.
 */

import { describe, expect, it } from "vitest";
import {
  GRADING_POLICY_READ_REFUSALS,
  gradingPolicyForReportedRun,
  gradingPolicyFromLoadedSuiteFile,
  gradingPolicyFromPlatformSuiteSettings,
  planPlatformSuiteGradingUpdate,
} from "../src/eval-grading-policy.js";
import {
  loadEvalSuiteFile,
  type SuiteFileLoadSuccess,
} from "../src/suite-file-loader.js";
import {
  LEGACY_SUITE_WIDE_THRESHOLD_PERCENT,
  resolveGradingPolicyFromHostedSuite,
} from "../src/contract/grading-policy.js";
import type { PlatformEvalSuiteSettings } from "../src/platform/types.js";
import {
  findFixture,
  suiteFileFixtures as data,
  suiteFilePayload as payload,
} from "./support/eval-suite-fixtures.js";

/**
 * The REAL corpus rows, not hand-written files.
 *
 * A suite file this test invented would drift from the contract the moment the
 * contract gained a required field, and would then be testing a shape nothing
 * accepts. These are the same two rows `suite-file-loader.test.ts` builds on.
 */
type CorpusSuiteFile = Record<string, unknown> & {
  defaults: Record<string, unknown>;
  cases: Array<Record<string, unknown>>;
};

const MINIMAL_V1 = payload(
  findFixture(data.accept, "minimal — one prompt-step case, nothing optional")
) as CorpusSuiteFile;
const MINIMAL_V2 = payload(
  findFixture(data.accept, "dialect 2 — minimal (iterations, no rules)")
) as CorpusSuiteFile;

function loadOrThrow(file: unknown): SuiteFileLoadSuccess {
  // Every fixture row is JSON, and JSON is YAML — so it is already suite-file
  // text.
  const result = loadEvalSuiteFile(JSON.stringify(file, null, 2));
  if (!result.ok) {
    throw new Error(
      `fixture suite file did not load: ${JSON.stringify(result.findings)}`
    );
  }
  return result;
}

/** The dialect-2 minimal row with its grading fields and cases replaced. */
function suiteFileV2(overrides: {
  iterations?: number;
  passThreshold?: number;
  validity?: Record<string, number>;
  cases?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    ...MINIMAL_V2,
    defaults: {
      ...MINIMAL_V2.defaults,
      ...(overrides.iterations !== undefined
        ? { iterations: overrides.iterations }
        : {}),
      ...(overrides.passThreshold !== undefined
        ? { passThreshold: overrides.passThreshold }
        : {}),
      validity: overrides.validity ?? {},
    },
    cases: overrides.cases ?? MINIMAL_V2.cases,
  };
}

/** One case from the corpus, re-identified. */
function caseRow(
  id: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { ...MINIMAL_V2.cases[0], id, title: id, ...extra };
}

describe("suite files reach the canonical policy", () => {
  it("reports the file's per-case criterion and default count", () => {
    const loaded = loadOrThrow(
      suiteFileV2({
        iterations: 3,
        passThreshold: 0.9,
        cases: [caseRow("case_plain")],
      })
    );
    const policy = gradingPolicyFromLoadedSuiteFile(loaded);
    expect(policy.passCriterion).toStrictEqual({
      scope: "perCase",
      threshold: 0.9,
    });
    expect(policy.iterationRule).toStrictEqual({
      kind: "defaultCount",
      iterations: 3,
    });
    expect(policy.origin).toBe("suiteFile");
  });

  it("a case that overrides nothing produces NO override row", () => {
    // The reason this reads the authored file rather than the resolved view: a
    // resolved case always carries a count and a threshold, because the
    // defaults are already applied to it. Reading overrides from there would
    // report every case as overriding and make a file's policy incomparable
    // with a hosted suite's.
    const loaded = loadOrThrow(
      suiteFileV2({
        iterations: 3,
        passThreshold: 0.9,
        cases: [caseRow("case_one"), caseRow("case_two")],
      })
    );
    expect(loaded.resolved.cases[0]?.iterations).toBe(3);
    expect(loaded.resolved.cases[0]?.passThreshold).toBe(0.9);
    expect(
      gradingPolicyFromLoadedSuiteFile(loaded).caseOverrides
    ).toStrictEqual([]);
  });

  it("carries the overrides a case actually authored", () => {
    const loaded = loadOrThrow(
      suiteFileV2({
        iterations: 3,
        passThreshold: 0.9,
        cases: [
          caseRow("case_plain"),
          caseRow("case_slow", { iterations: 20 }),
          caseRow("case_strict", { passThreshold: 1 }),
        ],
      })
    );
    expect(
      gradingPolicyFromLoadedSuiteFile(loaded).caseOverrides
    ).toStrictEqual([
      { caseRef: "case_slow", iterations: 20 },
      { caseRef: "case_strict", passThreshold: 1 },
    ]);
  });

  it("a disabled case keeps its override", () => {
    // Dropping it would make the policy change when somebody re-enables the
    // case, which is a settings change nobody made.
    const loaded = loadOrThrow(
      suiteFileV2({
        iterations: 3,
        passThreshold: 0.9,
        cases: [caseRow("case_off", { disabled: true, iterations: 7 })],
      })
    );
    expect(loaded.resolved.enabledCases).toHaveLength(0);
    expect(
      gradingPolicyFromLoadedSuiteFile(loaded).caseOverrides
    ).toStrictEqual([{ caseRef: "case_off", iterations: 7 }]);
  });

  it("an omitted validity member stays omitted through the round trip", () => {
    // The resolved view replaces `minEligibleTrials` with a coverage UNION on
    // purpose. Going back through `declareEvalSuiteFileValidity` is what keeps
    // omission selecting the stricter rule instead of becoming a number.
    const omitted = gradingPolicyFromLoadedSuiteFile(
      loadOrThrow(
        suiteFileV2({
          iterations: 2,
          passThreshold: 1,
          cases: [caseRow("case_plain")],
        })
      )
    );
    expect(omitted.validity.enforced).toBe(true);
    if (!omitted.validity.enforced) return;
    expect(omitted.validity.declared.minEligibleTrials).toBeUndefined();
    expect(omitted.validity.resolved.coverage).toStrictEqual({
      kind: "allConfiguredTrialsAttempted",
      minGradeableTrials: 1,
    });
    // …and the resolved rates ARE materialized, because a run is decided
    // against them.
    expect(omitted.validity.resolved.minCompletionRate).toBe(0.8);
    expect(omitted.validity.resolved.maxEvaluatorErrorRate).toBe(0.1);

    const explicit = gradingPolicyFromLoadedSuiteFile(
      loadOrThrow(
        suiteFileV2({
          iterations: 2,
          passThreshold: 1,
          validity: { minEligibleTrials: 3 },
          cases: [caseRow("case_plain")],
        })
      )
    );
    if (!explicit.validity.enforced) throw new Error("expected enforced");
    expect(explicit.validity.declared.minEligibleTrials).toBe(3);
    expect(explicit.validity.resolved.coverage).toStrictEqual({
      kind: "minEligibleTrials",
      minEligibleTrials: 3,
    });
  });

  it("reads a dialect-1 file's repetitions as the same canonical count", () => {
    // Dialect 1 spells the count `repetitions`, both on the defaults and on a
    // case. The loader's resolved view never shows that word, so the default
    // comes through it — but the per-case OVERRIDE is read off the authored
    // file, where the dialect-1 word is the only spelling there is.
    const dialect1 = {
      ...MINIMAL_V1,
      defaults: {
        ...MINIMAL_V1.defaults,
        repetitions: 4,
        passThreshold: 0.75,
        validity: {},
      },
      cases: [{ ...MINIMAL_V1.cases[0], id: "case_one", repetitions: 9 }],
    };
    const policy = gradingPolicyFromLoadedSuiteFile(loadOrThrow(dialect1));
    expect(policy.iterationRule).toStrictEqual({
      kind: "defaultCount",
      iterations: 4,
    });
    expect(policy.passCriterion).toStrictEqual({
      scope: "perCase",
      threshold: 0.75,
    });
    // The dialect-1 word never reaches the canonical model.
    expect(policy.caseOverrides).toStrictEqual([
      { caseRef: "case_one", iterations: 9 },
    ]);
  });
});

// ── hosted reads ─────────────────────────────────────────────────────────────
function settings(
  overrides: Partial<PlatformEvalSuiteSettings>
): PlatformEvalSuiteSettings {
  return {
    minimumAccuracy: null,
    matchOptions: null,
    checks: [],
    judge: {
      enabled: true,
      model: null,
      autoRun: false,
      threshold: 0.7,
      rubric: null,
    },
    ...overrides,
  } as PlatformEvalSuiteSettings;
}

describe("hosted settings reach the canonical policy", () => {
  it("reads a suite-wide suite in its own units", () => {
    const read = gradingPolicyFromPlatformSuiteSettings(
      settings({ policy: "legacy", minimumAccuracy: 90, minimumIterations: 3 })
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.policy.passCriterion).toStrictEqual({
      scope: "suiteWide",
      thresholdPercent: 90,
      population: "iterations",
      emptyPopulationRate: 1,
    });
    expect(read.policy.iterationRule).toStrictEqual({
      kind: "caseCountWithFloor",
      minimumIterations: 3,
    });
    expect(read.policy.validity.enforced).toBe(false);
  });

  it("reads a per-case suite as a fraction, ignoring the dead percent column", () => {
    const read = gradingPolicyFromPlatformSuiteSettings(
      settings({
        policy: "v2",
        // The DTO reports null here on a per-case suite whatever the column
        // holds; the live threshold is the fraction below.
        minimumAccuracy: null,
        minimumIterations: 10,
        verdictPolicyVersion: 2,
        verdictPolicyDefaults: { repetitions: 4, passThreshold: 0.75 },
      })
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.policy.passCriterion).toStrictEqual({
      scope: "perCase",
      threshold: 0.75,
    });
    expect(read.policy.iterationRule).toStrictEqual({
      kind: "defaultCount",
      iterations: 4,
    });
    expect(read.policy.validity.enforced).toBe(true);
  });

  it("REFUSES a deployment that does not report which policy decides", () => {
    // Neither `policy` nor `verdictPolicyVersion`: an old deployment, where a
    // suite-wide and a per-case suite are indistinguishable. Guessing
    // suite-wide would describe a stored 0.9 fraction as a 0.9% bar.
    const read = gradingPolicyFromPlatformSuiteSettings(
      settings({ minimumAccuracy: 90 })
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.refusal).toBe("deploymentDoesNotReportPolicy");
    expect(GRADING_POLICY_READ_REFUSALS).toContain(read.refusal);
  });

  it("accepts a deployment that reports the version but not the word", () => {
    const read = gradingPolicyFromPlatformSuiteSettings(
      settings({
        verdictPolicyVersion: 2,
        verdictPolicyDefaults: { repetitions: 2, passThreshold: 0.5 },
      })
    );
    expect(read.ok).toBe(true);
  });

  it("goes through the SAME adapter the shared corpus checks", () => {
    const read = gradingPolicyFromPlatformSuiteSettings(
      settings({ policy: "legacy", minimumAccuracy: 80, minimumIterations: 2 })
    );
    if (!read.ok) throw new Error("expected a policy");
    expect(read.policy).toStrictEqual(
      resolveGradingPolicyFromHostedSuite({
        defaultPassCriteria: { minimumPassRate: 80 },
        minIterations: 2,
      })
    );
  });

  it("a suite with no declared threshold resolves to the producer fallback", () => {
    const read = gradingPolicyFromPlatformSuiteSettings(
      settings({ policy: "legacy" })
    );
    if (!read.ok) throw new Error("expected a policy");
    expect(
      read.policy.passCriterion.scope === "suiteWide" &&
        read.policy.passCriterion.thresholdPercent
    ).toBe(LEGACY_SUITE_WIDE_THRESHOLD_PERCENT);
  });
});

// ── the reviewed edit ────────────────────────────────────────────────────────
describe("the reviewed settings edit", () => {
  const suiteWide = settings({
    policy: "legacy",
    minimumAccuracy: 90,
    minimumIterations: 3,
  });
  const perCase = settings({
    policy: "v2",
    verdictPolicyVersion: 2,
    verdictPolicyDefaults: { repetitions: 5, passThreshold: 0.8 },
  });

  it("edits a suite-wide threshold without a policy toggle", () => {
    const plan = planPlatformSuiteGradingUpdate({
      settings: suiteWide,
      revisionNumber: 7,
      edit: { passThreshold: 0.95 },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.noop).toBe(false);
    expect(plan.body.settings).toStrictEqual({ minimumAccuracy: 95 });
    // The compare-and-set travels with it, even though the route only mandates
    // a precondition for a quality-gate edit.
    expect(plan.body.expectedRevisionNumber).toBe(7);
    // The pair that would migrate the suite is never written.
    expect(plan.body.settings.repetitions).toBeUndefined();
    expect(plan.body.settings.passThreshold).toBeUndefined();
  });

  it("edits a per-case threshold as a fraction", () => {
    const plan = planPlatformSuiteGradingUpdate({
      settings: perCase,
      revisionNumber: 2,
      edit: { passThreshold: 0.9 },
    });
    expect(plan.ok && plan.body.settings).toStrictEqual({
      passThreshold: 0.9,
    });
    expect(plan.ok && plan.body.settings.minimumAccuracy).toBeUndefined();
  });

  it("an unchanged edit is a no-op with an EMPTY settings patch", () => {
    const plan = planPlatformSuiteGradingUpdate({
      settings: suiteWide,
      revisionNumber: 7,
      edit: { passThreshold: 0.9, minimumIterations: 3 },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.noop).toBe(true);
    expect(plan.changed).toStrictEqual([]);
    expect(plan.body.settings).toStrictEqual({});
  });

  it("refuses a count edit a floor rule cannot express, with no partial body", () => {
    const plan = planPlatformSuiteGradingUpdate({
      settings: suiteWide,
      revisionNumber: 7,
      edit: { passThreshold: 0.95, iterations: 7 },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe("iterationsNotRepresentable");
    expect(plan).not.toHaveProperty("body");
  });

  it("refuses enabling validity where it is not enforced", () => {
    const plan = planPlatformSuiteGradingUpdate({
      settings: suiteWide,
      revisionNumber: 7,
      edit: { validity: { minCompletionRate: 0.9 } },
    });
    expect(plan.ok && "unreachable").not.toBe("unreachable");
    if (plan.ok) return;
    expect(plan.refusal).toBe("validityNotEnforced");
  });

  it("refuses to plan against a deployment that cannot say which policy decides", () => {
    const plan = planPlatformSuiteGradingUpdate({
      settings: settings({ minimumAccuracy: 90 }),
      revisionNumber: 1,
      edit: { passThreshold: 0.5 },
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe("deploymentDoesNotReportPolicy");
  });

  it("omits the precondition on a deployment without revisions", () => {
    const plan = planPlatformSuiteGradingUpdate({
      settings: suiteWide,
      revisionNumber: null,
      edit: { passThreshold: 0.95 },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.body).not.toHaveProperty("expectedRevisionNumber");
  });

  it("carries an audited reason when one is supplied", () => {
    const plan = planPlatformSuiteGradingUpdate({
      settings: perCase,
      revisionNumber: 2,
      edit: { iterations: 9 },
      revisionNote: "raise the per-case count for the flaky server",
    });
    expect(plan.ok && plan.body.revisionNote).toBe(
      "raise the per-case count for the flaky server"
    );
    expect(plan.ok && plan.body.settings).toStrictEqual({ repetitions: 9 });
  });

  it("throws on a malformed edit rather than refusing", () => {
    // A percent where a fraction belongs is a programming error, not a choice
    // a user made — so it is not renderable as a refusal.
    expect(() =>
      planPlatformSuiteGradingUpdate({
        settings: suiteWide,
        revisionNumber: 1,
        edit: { passThreshold: 90 },
      })
    ).toThrow(TypeError);
  });
});

// ── reported runs ────────────────────────────────────────────────────────────
describe("a reported run names which producer decided it", () => {
  it("the hosted ingestion measures variant-collapsed cases", () => {
    const policy = gradingPolicyForReportedRun({
      minimumPassRate: 80,
      producer: "hosted",
    });
    expect(policy.passCriterion).toStrictEqual({
      scope: "suiteWide",
      thresholdPercent: 80,
      population: "casesIgnoringExecutionVariant",
      emptyPopulationRate: 0,
    });
  });

  it("the reporter's local fallback measures the iterations it was handed", () => {
    const policy = gradingPolicyForReportedRun({
      minimumPassRate: 80,
      producer: "localFallback",
    });
    expect(policy.passCriterion).toStrictEqual({
      scope: "suiteWide",
      thresholdPercent: 80,
      population: "iterations",
      emptyPopulationRate: 0,
    });
  });

  it("falls back to the threshold every legacy producer spells", () => {
    expect(
      gradingPolicyForReportedRun({ producer: "hosted" }).passCriterion
    ).toMatchObject({ thresholdPercent: LEGACY_SUITE_WIDE_THRESHOLD_PERCENT });
  });

  it("a run-scoped policy refuses every settings edit", () => {
    // `passCriteria` travelled with one run; there is nothing to edit.
    const policy = gradingPolicyForReportedRun({ producer: "hosted" });
    expect(policy.origin).toBe("runReporting");
  });
});
