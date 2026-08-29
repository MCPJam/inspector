/**
 * The canonical run decision summary, against the golden corpus.
 *
 * The corpus (`fixtures/eval-run-decision-summary-fixtures.json`) is shared with
 * the API route test, the MCP operation test and the CLI reporter tests, because
 * the claim D9 makes is not "the assembler works" — it is that FOUR surfaces
 * produce one reading of a run. A corpus each would prove each of them
 * self-consistent and nothing about the four together.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assembleEvalRunDecisionSummary,
  DECISION_LABEL_VOCABULARIES,
  EVAL_RUN_DECISION_SUMMARY_SCHEMA_VERSION,
  EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS,
  EVAL_RUN_DECISION_UNDECIDED_REASONS,
  EVAL_RUN_DECISION_VERDICT_LABELS,
  EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS,
  EVAL_RUN_DECISION_VERDICT_SOURCES,
  EVAL_RUN_DECISION_VERDICTS,
  EVAL_RUN_MEASUREMENT_UNIT_LABELS,
  EVAL_RUN_MEASUREMENT_UNITS,
  EVAL_VERDICT_DECISION_REASON_LABELS,
  evalRunDecisionSummarySchema,
  FAILURE_CATEGORY_LABELS,
  STAGE_ANALYZER_VERSION,
  STAGE_REASON_LABELS,
  STAGE_STATE_LABELS,
  USER_VALUE_STAGE_LABELS,
  type EvalRunDecisionAssemblyInput,
  type EvalRunDecisionSummary,
} from "../src/contract/index.js";
import { formatEvalRunDecisionSummary } from "../src/eval-decision-summary.js";

type Fixture = {
  __name: string;
  __why: string;
  input: EvalRunDecisionAssemblyInput;
  expected: EvalRunDecisionSummary;
};

const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "./fixtures/eval-run-decision-summary-fixtures.json",
        import.meta.url
      )
    ),
    "utf8"
  )
) as { cases: Fixture[] };

/**
 * The span-id slug each stage's FAILED row uses in the corpus.
 *
 * Deliberately not the wire enum: a span id is opaque producer data and is
 * printed verbatim, so a fixture that spelled one `span-userValue-failed` would
 * make the renderer's "never print a raw enum" assertion pass or fail on the
 * fixture's own choice of identifier rather than on the renderer.
 */
const STAGE_SPAN_SLUG: Record<string, string> = {
  connection: "connection",
  discovery: "discovery",
  selection: "selection",
  call: "tool-call",
  response: "response",
  userValue: "user-value",
};

const byName = (name: string): Fixture => {
  const row = corpus.cases.find((entry) => entry.__name === name);
  if (!row) throw new Error(`no fixture named "${name}"`);
  return row;
};

describe("eval run decision summary — golden corpus", () => {
  it("covers every shape D9 pins", () => {
    // A corpus that quietly loses a row stops testing the case it was added
    // for while still passing, so the roster is asserted rather than assumed.
    expect(corpus.cases.map((row) => row.__name).sort()).toEqual(
      [
        "category-without-first-failed-stage",
        "inconclusive-evaluator-errors-above-ceiling",
        "inconclusive-no-gradeable-trials",
        "legacy-cancelled-run-is-notEstablished",
        "legacy-run-trial-counts",
        "legacy-run-without-counts",
        "measured-failure-at-every-stage",
        "mixed-repetitions-case-fails-by-threshold",
        "mixed-repetitions-case-passes-by-threshold",
        "non-terminal-run-is-notEstablished",
        "partial-diagnostics-page",
        "policy-block-is-not-a-failure",
        "policyV2-decision-unreadable",
        "policyV2-passing",
        "unverified-and-version-ahead",
      ].sort()
    );
    expect(corpus.cases.every((row) => row.__why.length > 0)).toBe(true);
  });

  for (const row of corpus.cases) {
    it(`${row.__name}: assembles to the checked-in summary`, () => {
      expect(assembleEvalRunDecisionSummary(row.input)).toEqual(row.expected);
    });

    it(`${row.__name}: validates against the contract schema`, () => {
      const parsed = evalRunDecisionSummarySchema.safeParse(row.expected);
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    });

    it(`${row.__name}: is stable under re-assembly`, () => {
      // Byte-equivalence is the property the API route and the CLI fallback
      // both rely on. Assembling twice is the cheapest proof there is no
      // hidden ordering or identity in the output.
      expect(JSON.stringify(assembleEvalRunDecisionSummary(row.input))).toEqual(
        JSON.stringify(assembleEvalRunDecisionSummary(row.input))
      );
    });
  }
});

describe("verdict authority", () => {
  it("copies the policy-v2 verdict rather than deriving one from trials", () => {
    const row = byName("mixed-repetitions-case-passes-by-threshold");
    // Two of four trials FAILED, and the run PASSED: the case met its
    // threshold. A summary that counted the diagnostics would report a failure
    // the platform never reached.
    expect(row.expected.diagnostics.items).toHaveLength(2);
    expect(row.expected.verdict).toBe("passed");
    expect(row.expected.verdictSource).toBe("policyV2");
    expect(row.expected.counts).toEqual({
      measurementUnit: "caseVariant",
      total: 1,
      passed: 1,
      failed: 0,
      inconclusive: 0,
    });
  });

  it("never labels case variants and trials with the same word", () => {
    expect(byName("policyV2-passing").expected.counts?.measurementUnit).toBe(
      "caseVariant"
    );
    expect(
      byName("legacy-run-trial-counts").expected.counts?.measurementUnit
    ).toBe("trial");
  });

  it("keeps inconclusive out of failed", () => {
    for (const name of [
      "inconclusive-no-gradeable-trials",
      "inconclusive-evaluator-errors-above-ceiling",
    ]) {
      expect(byName(name).expected.verdict).toBe("inconclusive");
    }
  });

  it("reports an undecided run as notEstablished, with the check that left it there", () => {
    expect(
      byName("non-terminal-run-is-notEstablished").expected.undecided
    ).toEqual({
      reason: "runNotTerminal",
    });
    expect(
      byName("legacy-cancelled-run-is-notEstablished").expected.undecided
    ).toEqual({ reason: "runStatusNotAVerdict" });
    // The platform's own message is carried, never invented.
    expect(byName("policyV2-decision-unreadable").expected.undecided).toEqual({
      reason: "verdictSummaryUnavailable",
      detail: "mixed evaluator configs across iterations",
    });
    // And a run with no verdict reports no counts at all.
    expect(
      byName("legacy-cancelled-run-is-notEstablished").expected.counts
    ).toBeUndefined();
  });

  it("does not fall back to legacy semantics for an undecidable v2 run", () => {
    const row = byName("policyV2-decision-unreadable");
    expect(row.expected.verdictSource).toBe("none");
    expect(row.expected.verdict).toBe("notEstablished");
  });

  it("keeps absence absent for a legacy run that recorded no summary", () => {
    expect(byName("legacy-run-without-counts").expected.counts).toBeUndefined();
  });
});

describe("evidence is attached to the claim it supports", () => {
  it("reads the locator from the first failed stage's row only", () => {
    const row = byName("measured-failure-at-every-stage");
    for (const item of row.expected.diagnostics.items) {
      expect(item.chain.status).toBe("verified");
      if (item.chain.status !== "verified") continue;
      const stage = item.chain.firstFailedStage;
      expect(stage).toBeDefined();
      expect(item.evidence.stage).toBe(stage);
      // Every passing stage in these fixtures carries `span-ok-<n>`; the
      // failed row carries `span-<stage>-failed`. A union would drag the
      // former in and present the evidence of what worked as the explanation
      // of what did not.
      expect(
        item.evidence.spanIds?.some((id) => id.startsWith("span-ok-"))
      ).toBe(false);
      expect(item.evidence.spanIds).toEqual([
        `span-${STAGE_SPAN_SLUG[stage!]}-failed`,
      ]);
    }
  });

  it("leaves a stage-less outcome stage-less", () => {
    for (const item of byName("category-without-first-failed-stage").expected
      .diagnostics.items) {
      expect(item.evidence.stage).toBeUndefined();
      expect(item.evidence.spanIds).toBeUndefined();
      // But it still says where to look.
      expect(item.evidence.tracePath).toContain("/trace");
    }
  });

  it("gives every diagnostic a resolvable, API-relative trace path", () => {
    for (const row of corpus.cases) {
      for (const item of row.expected.diagnostics.items) {
        expect(item.evidence.tracePath).toBe(
          `/projects/${row.input.projectId}/eval-runs/${row.input.run.id}` +
            `/iterations/${item.iterationId}/trace`
        );
      }
    }
  });

  it("withholds the rejected claim from an unverified chain", () => {
    const [quarantined, ahead] = byName("unverified-and-version-ahead").expected
      .diagnostics.items;
    expect(quarantined!.chain).toEqual({
      status: "unverified",
      analyzerVersion: 4,
    });
    expect(quarantined!.nextAction).toBe(
      "inspect the case trace; no failure category was recorded"
    );
    // Version-ahead is FLAGGED, not rejected.
    expect(ahead!.chain.status).toBe("verified");
    if (ahead!.chain.status === "verified") {
      // `known` is whatever analyzer THIS build ships, asserted by meaning
      // rather than by a literal: pinning both numbers here duplicated the
      // fixture comparison above and turned every analyzer bump into an edit
      // in two places. `reported` stays a far-future constant so the case keeps
      // exercising version-ahead as the analyzer advances.
      expect(ahead!.chain.analyzerVersionAhead).toEqual({
        reported: 99,
        known: STAGE_ANALYZER_VERSION,
      });
      expect(ahead!.chain.firstFailedStage).toBe("call");
    }
  });

  it("claims no failure category for a policy block", () => {
    const [blocked] = byName("policy-block-is-not-a-failure").expected
      .diagnostics.items;
    expect(blocked!.chain.status).toBe("verified");
    if (blocked!.chain.status === "verified") {
      expect(blocked!.chain.failureCategory).toBeUndefined();
      expect(blocked!.chain.firstFailedStage).toBeUndefined();
      expect(
        blocked!.chain.stages.every((stage) => stage.state === "notMeasured")
      ).toBe(true);
    }
  });
});

describe("diagnostics honesty", () => {
  it("reports a partial page as partial, with its cursor", () => {
    const page = byName("partial-diagnostics-page").expected.diagnostics;
    expect(page.complete).toBe(false);
    expect(page.nextCursor).toBe("cursor-page-2");
    // The passing iteration on the page was examined and is not a diagnostic:
    // scanned counts what was looked at, `items` what failed.
    expect(page.scannedIterations).toBe(2);
    expect(page.items).toHaveLength(1);
  });

  it("distinguishes 'nothing failed' from 'we did not look'", () => {
    const page = byName("policyV2-passing").expected.diagnostics;
    expect(page.items).toEqual([]);
    expect(page.scannedIterations).toBe(1);
    expect(page.complete).toBe(true);
  });
});

describe("the schema refuses a self-inconsistent summary", () => {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const refuse = (
    mutate: (summary: any) => void,
    seed = "policyV2-passing"
  ) => {
    const summary = clone(byName(seed).expected) as any;
    mutate(summary);
    const parsed = evalRunDecisionSummarySchema.safeParse(summary);
    expect(parsed.success).toBe(false);
    return parsed.success
      ? ""
      : parsed.error.issues.map((i) => i.message).join(" | ");
  };

  it("refuses counts that drift from the decision they claim to tally", () => {
    expect(
      refuse((s) => {
        s.counts.passed = 0;
        s.counts.failed = 1;
      })
    ).toContain("tally of decision.cases");
  });

  it("refuses a verdict that is not the decision's own", () => {
    expect(
      refuse((s) => {
        s.verdict = "failed";
      })
    ).toContain("it never re-decides one");
  });

  it("refuses a policyV2 source with no decision", () => {
    expect(
      refuse((s) => {
        delete s.decision;
      })
    ).toContain("requires the decision it names as the authority");
  });

  it("refuses a legacy or undecided summary that smuggles in a decision", () => {
    expect(
      refuse((s) => {
        s.decision = clone(byName("policyV2-passing").expected).decision;
      }, "legacy-run-trial-counts")
    ).toContain('only a "policyV2" summary carries a decision');
  });

  it("refuses case-variant counts on a legacy run", () => {
    expect(
      refuse((s) => {
        s.counts.measurementUnit = "caseVariant";
        s.counts.inconclusive = 0;
      }, "legacy-run-trial-counts")
    ).toContain("counts trials");
  });

  it("refuses counts on a run with no verdict", () => {
    expect(
      refuse((s) => {
        s.counts = { measurementUnit: "trial", total: 3, passed: 3, failed: 0 };
      }, "non-terminal-run-is-notEstablished")
    ).toContain("a decision nobody took");
  });

  it("refuses a notEstablished verdict with no reason", () => {
    expect(
      refuse((s) => {
        delete s.undecided;
      }, "non-terminal-run-is-notEstablished")
    ).toContain("which check left it undecided");
  });

  it("refuses a complete page that still has a next cursor", () => {
    expect(
      refuse((s) => {
        s.diagnostics.nextCursor = "more";
      })
    ).toContain("the set is not complete");
  });

  it("refuses more diagnostics than iterations examined", () => {
    expect(
      refuse((s) => {
        s.diagnostics.scannedIterations = 0;
      }, "partial-diagnostics-page")
    ).toContain("fewer than the");
  });

  it("refuses an unknown field", () => {
    expect(
      refuse((s) => {
        s.rootCauseAnalysis = true;
      })
    ).toBeTruthy();
  });

  it("pins the schema version", () => {
    expect(EVAL_RUN_DECISION_SUMMARY_SCHEMA_VERSION).toBe(1);
    expect(
      refuse((s) => {
        s.schemaVersion = 2;
      })
    ).toBeTruthy();
  });
});

describe("labels are total over the vocabularies they render", () => {
  const total = (
    labels: Readonly<Record<string, unknown>>,
    vocabulary: readonly string[]
  ) => {
    expect(Object.keys(labels).sort()).toEqual([...vocabulary].sort());
  };

  it("covers every stage, state, category, stage reason and verdict reason", () => {
    total(USER_VALUE_STAGE_LABELS, DECISION_LABEL_VOCABULARIES.stages);
    total(STAGE_STATE_LABELS, DECISION_LABEL_VOCABULARIES.stageStates);
    total(
      FAILURE_CATEGORY_LABELS,
      DECISION_LABEL_VOCABULARIES.failureCategories
    );
    total(STAGE_REASON_LABELS, DECISION_LABEL_VOCABULARIES.stageReasons);
    total(
      EVAL_VERDICT_DECISION_REASON_LABELS,
      DECISION_LABEL_VOCABULARIES.verdictDecisionReasons
    );
  });

  it("covers this contract's own vocabularies", () => {
    total(EVAL_RUN_DECISION_VERDICT_LABELS, EVAL_RUN_DECISION_VERDICTS);
    total(
      EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS,
      EVAL_RUN_DECISION_VERDICT_SOURCES
    );
    total(EVAL_RUN_MEASUREMENT_UNIT_LABELS, EVAL_RUN_MEASUREMENT_UNITS);
    total(
      EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS,
      EVAL_RUN_DECISION_UNDECIDED_REASONS
    );
  });

  it("spells the chain's last stage as words", () => {
    expect(USER_VALUE_STAGE_LABELS.userValue).toBe("User value");
  });
});

describe("the human renderer", () => {
  const rendered = corpus.cases.map((row) => ({
    name: row.__name,
    text: formatEvalRunDecisionSummary(row.expected),
  }));

  it("never prints a raw wire enum at a human", () => {
    for (const { name, text } of rendered) {
      // `userValue` is the worst of them and the one a reader is most likely
      // to meet: it is the last stage, so it is where a mechanically perfect
      // run still fails.
      expect(text, name).not.toContain("userValue");
      expect(text, name).not.toContain("argumentMismatch");
      expect(text, name).not.toContain("notEstablished");
      expect(text, name).not.toContain("caseVariant");
    }
  });

  it("never diagnoses", () => {
    for (const { name, text } of rendered) {
      expect(text.toLowerCase(), name).not.toContain("root cause");
    }
  });

  it("prints the unit beside the count", () => {
    expect(
      rendered.find((row) => row.name === "policyV2-passing")!.text
    ).toContain("1/1 case variant passed");
    expect(
      rendered.find((row) => row.name === "legacy-run-trial-counts")!.text
    ).toContain("4/6 trials passed");
  });

  it("says a partial page is partial", () => {
    expect(
      rendered.find((row) => row.name === "partial-diagnostics-page")!.text
    ).toContain("PARTIAL");
  });

  it("explains an inconclusive run with the decision's own reasons", () => {
    const text = rendered.find(
      (row) => row.name === "inconclusive-evaluator-errors-above-ceiling"
    )!.text;
    expect(text).toContain("inconclusive");
    expect(text).toContain(
      EVAL_VERDICT_DECISION_REASON_LABELS.evaluatorErrorRateAboveMaximum
    );
  });

  it("names the stage the evidence was read from", () => {
    const text = rendered.find(
      (row) => row.name === "measured-failure-at-every-stage"
    )!.text;
    expect(text).toContain("First failed stage: User value");
    expect(text).toContain("Evidence at Tool call:");
  });
});
