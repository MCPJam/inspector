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
  DECISION_SUMMARY_STALE_ANALYZER_DISAGREEMENT_NEXT_ACTION,
  DECISION_SUMMARY_VERDICT_CHAIN_DISAGREEMENT_NEXT_ACTION,
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
  evalStageCoverageDetailSchema,
  EXCLUDED_TRIAL_DETAIL_LABELS,
  FAILURE_CATEGORY_LABELS,
  STAGE_ANALYZER_VERSION,
  STAGE_REASON_LABELS,
  STAGE_STATE_LABELS,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_OUTCOMES,
  USER_VALUE_STAGE_QUESTIONS,
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

  // ── UVH-IN3: naming a verdict/chain disagreement ──────────────────────────
  //
  // Built by cloning a real fixture input and overriding only the iteration's
  // chain, so the surrounding envelope stays exactly what the assembler is
  // fed in production rather than a hand-rolled approximation of it.

  const disagreementInput = (opts: {
    analyzerVersion: number;
    /** `null` is a trial that recorded no verdict at all. */
    result?: string | null;
    failSelection?: boolean;
    /** Selection reached but unreadable — an evidence gap, not a clean chain. */
    unmeasureSelection?: boolean;
    /** Selection out of scope for this case — not a gap at all. */
    selectionNotApplicable?: boolean;
    /**
     * Keep `firstFailedStage` (the schema requires it to name the failed row)
     * but record NO category. `failureCategory` is read from the stored row
     * and the schema does not couple it to the states, so the two can be out
     * of step on a row the analyzer did not write whole.
     */
    withoutCategory?: boolean;
  }): EvalRunDecisionAssemblyInput => {
    const base = structuredClone(
      byName("policy-block-is-not-a-failure").input
    ) as EvalRunDecisionAssemblyInput & {
      iterations: Array<Record<string, unknown>>;
    };
    const iteration = base.iterations[0]!;
    iteration.result = opts.result === undefined ? "failed" : opts.result;
    iteration.stageAnalyzerVersion = opts.analyzerVersion;
    // Everything the chain could measure came back ok — the shape that used
    // to read as "no failure category was recorded".
    iteration.stageResults = [
      { stage: "connection", state: "passed", reason: "observed" },
      { stage: "discovery", state: "passed", reason: "observed" },
      {
        stage: "selection",
        ...(opts.failSelection
          ? { state: "failed", reason: "missingToolCall" }
          : opts.unmeasureSelection
            ? { state: "notMeasured", reason: "noEvidenceCaptured" }
            : opts.selectionNotApplicable
              ? { state: "notApplicable", reason: "notAuthored" }
              : { state: "passed", reason: "observed" }),
      },
      { stage: "call", state: "passed", reason: "observed" },
      { stage: "response", state: "passed", reason: "observed" },
      { stage: "userValue", state: "passed", reason: "observed" },
    ];
    if (opts.failSelection) {
      iteration.firstFailedStage = "selection";
      if (!opts.withoutCategory) iteration.failureCategory = "selection";
    }
    return base;
  };

  it("names the disagreement when the chain measured everything and found it ok", () => {
    // "No failure category was recorded" is true of this run but describes it
    // as MISSING information, when in fact two things we hold are in
    // conflict — a different investigation entirely.
    const summary = assembleEvalRunDecisionSummary(
      disagreementInput({ analyzerVersion: STAGE_ANALYZER_VERSION })
    );
    expect(summary.diagnostics.items[0]!.nextAction).toBe(
      DECISION_SUMMARY_VERDICT_CHAIN_DISAGREEMENT_NEXT_ACTION
    );
  });

  it("tells a pre-7 chain to re-run, without naming a cause", () => {
    // The version proves the analyzer measured LESS than the current one. It
    // does not prove what went wrong. An earlier draft named the errored tool
    // call as the cause, which would have sent a reader after one specific
    // finding on every legacy row whatever actually happened.
    const action = assembleEvalRunDecisionSummary(
      disagreementInput({ analyzerVersion: 6 })
    ).diagnostics.items[0]!.nextAction;

    // Asserted against the exported constant, so a copy edit moves both at
    // once — and so the export itself is load-bearing: these two strings are
    // what the diagnostics RETURN, and a published consumer that cannot import
    // them has to hard-code our prose to recognise them.
    expect(action).toBe(
      DECISION_SUMMARY_STALE_ANALYZER_DISAGREEMENT_NEXT_ACTION
    );
    expect(action).toContain("older analyzer that measures less");
    expect(action).toContain("re-run");
    // The claim it must NOT make.
    expect(action).not.toContain("tool");
  });

  it("does NOT claim a disagreement when a stage was never measured", () => {
    // The gap the first predicate left. Connection and discovery passed and
    // nothing failed, so "something measured, nothing wrong" was satisfied —
    // but the verdict may be failing on exactly the stage the chain could not
    // read. That is a measurement gap, and calling it a conflict sends someone
    // looking for a contradiction that is not there.
    const summary = assembleEvalRunDecisionSummary(
      disagreementInput({
        analyzerVersion: STAGE_ANALYZER_VERSION,
        unmeasureSelection: true,
      })
    );
    expect(summary.diagnostics.items[0]!.nextAction).toBe(
      "inspect the case trace; no failure category was recorded"
    );
  });

  it("still claims a disagreement when a stage is notApplicable", () => {
    // The other side of that line. A stage the case never exercises is out of
    // scope, not missing evidence — requiring it to pass would make the claim
    // unreachable for every case that does not use all six stages.
    const summary = assembleEvalRunDecisionSummary(
      disagreementInput({
        analyzerVersion: STAGE_ANALYZER_VERSION,
        selectionNotApplicable: true,
      })
    );
    expect(summary.diagnostics.items[0]!.nextAction).toBe(
      DECISION_SUMMARY_VERDICT_CHAIN_DISAGREEMENT_NEXT_ACTION
    );
  });

  it("does NOT claim a disagreement when a stage actually failed", () => {
    const summary = assembleEvalRunDecisionSummary(
      disagreementInput({
        analyzerVersion: STAGE_ANALYZER_VERSION,
        failSelection: true,
      })
    );
    // A failed stage yields a category, so the fallback is never reached.
    expect(summary.diagnostics.items[0]!.nextAction).not.toContain("disagrees");
  });

  it("does NOT claim a disagreement over a failed stage with no category", () => {
    // `failureCategory` is read off the stored row rather than derived from
    // the stage states, and the derivation schema pins only `firstFailedStage`
    // to the failed row — never the category. So a row can validate carrying a
    // `failed` stage and no category, and that row lands in this fallback. "The chain found nothing wrong" is
    // then flatly contradicted by the row itself: the states are the evidence,
    // and a stage marked failed is the finding to go and read.
    const summary = assembleEvalRunDecisionSummary(
      disagreementInput({
        analyzerVersion: STAGE_ANALYZER_VERSION,
        failSelection: true,
        withoutCategory: true,
      })
    );
    const [item] = summary.diagnostics.items;
    expect(item!.chain.status).toBe("verified");
    if (item!.chain.status === "verified") {
      expect(item!.chain.failureCategory).toBeUndefined();
      expect(item!.chain.stages).toContainEqual({
        stage: "selection",
        state: "failed",
        reason: "missingToolCall",
      });
    }
    expect(item!.nextAction).toBe(
      "inspect the case trace; no failure category was recorded"
    );
  });

  it("does NOT claim a disagreement when there is no verdict to disagree WITH", () => {
    // A trial that recorded no verdict is still diagnosed — only `passed` is
    // filtered out — and its chain can perfectly well be all-`passed`. That is
    // the shape the claim must refuse: nothing was decided, so nothing is in
    // conflict, and calling it a disagreement would invent the other half.
    const summary = assembleEvalRunDecisionSummary(
      disagreementInput({
        analyzerVersion: STAGE_ANALYZER_VERSION,
        result: null,
      })
    );
    expect(summary.diagnostics.items[0]!.nextAction).toBe(
      "inspect the case trace; no failure category was recorded"
    );
  });

  it("never diagnoses a passing trial at all, so it cannot make the claim", () => {
    // Why the case above uses a missing verdict rather than a passing one:
    // diagnostics are drawn from the iterations that did NOT pass, so a passed
    // trial has no diagnostic to carry any nextAction. Pinned here because it
    // is the reason the disagreement wording can only ever appear on a run
    // someone is already investigating.
    const summary = assembleEvalRunDecisionSummary(
      disagreementInput({
        analyzerVersion: STAGE_ANALYZER_VERSION,
        result: "passed",
      })
    );
    expect(summary.diagnostics.items).toEqual([]);
    expect(summary.diagnostics.scannedIterations).toBe(1);
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
    // The two stage maps the chain cards read from. A stage added to the
    // contract without words here would render a card with a wire spelling
    // where its question and its outcome belong.
    total(USER_VALUE_STAGE_QUESTIONS, DECISION_LABEL_VOCABULARIES.stages);
    total(USER_VALUE_STAGE_OUTCOMES, DECISION_LABEL_VOCABULARIES.stages);
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

  it("covers the fine-grained exclusion detail against the SCHEMA, not a list", () => {
    // Read off `evalStageCoverageDetailSchema.shape` rather than a hand list:
    // a hand list is a second declaration of the vocabulary, and the one that
    // goes stale silently the day the schema gains a fifteenth key.
    total(
      EXCLUDED_TRIAL_DETAIL_LABELS,
      Object.keys(evalStageCoverageDetailSchema.shape)
    );
  });

  it("keeps the questions interrogative and the outcomes declarative", () => {
    // Named for what it actually pins. An earlier name promised "past tense",
    // which nothing below checks and nothing here could check cheaply — the
    // outcomes are past participles, and "made" and "satisfied" do not share a
    // suffix to match on. What IS mechanically checkable is that the two maps
    // stay in different moods: a question mark on one side and none on the
    // other. The wording itself is pinned by the two examples below.
    for (const question of Object.values(USER_VALUE_STAGE_QUESTIONS)) {
      expect(question.endsWith("?")).toBe(true);
    }
    for (const outcome of Object.values(USER_VALUE_STAGE_OUTCOMES)) {
      expect(outcome.endsWith("?")).toBe(false);
    }
    // The mock's own wording for the stage the chain is most often read at.
    expect(USER_VALUE_STAGE_OUTCOMES.response).toBe("Usable response returned");
    expect(USER_VALUE_STAGE_QUESTIONS.response).toBe(
      "Did the server return data the model could use?"
    );
  });

  it("never prints a wire spelling in the exclusion detail's words", () => {
    for (const [key, label] of Object.entries(EXCLUDED_TRIAL_DETAIL_LABELS)) {
      // `measurementsVersionAhead` is correct on the wire and unreadable in a
      // disclosure line; the map exists so the second never happens.
      //
      // CAMEL CASE is the test, not "does not contain the key": `cancelled` is
      // both a wire spelling and an ordinary English word, and a label that
      // refused to use it would be worse prose for no honesty gained. What
      // must never appear is an identifier a human did not write.
      expect(label, key).not.toMatch(/[a-z][A-Z]/);
      expect(label, key).not.toBe(key);
    }
  });

  it("describes the partial band inclusively at the floor", () => {
    // The band is `>= partialFloor` and `< threshold`, so a score exactly ON
    // the floor is partial. The label said "above the floor", which puts the
    // boundary score outside a band it is inside — and these strings are the
    // one place all four renderers read from, so the error would have been
    // shown everywhere and stated nowhere else.
    expect(STAGE_REASON_LABELS.judgePartial).toContain("at or above the floor");
    expect(STAGE_REASON_LABELS.judgePartial).toContain("below the threshold");
    // The sibling it has to stay consistent with: the threshold is inclusive
    // on the pass side for the same reason.
    expect(STAGE_REASON_LABELS.judgeObserved).toContain("at or above");
  });
});

describe("the human renderer", () => {
  const rendered = corpus.cases.map((row) => ({
    name: row.__name,
    text: formatEvalRunDecisionSummary(row.expected),
  }));

  it("never prints a raw wire enum at a human", () => {
    // BOTH LAYERS. The compact default and the `stages` detail read from the
    // same label maps, and a row renderer that reached for `row.state`
    // directly would only show up here.
    const everyLayer = [
      ...rendered,
      ...corpus.cases.map((row) => ({
        name: `${row.__name} (stages)`,
        text: formatEvalRunDecisionSummary(row.expected, { stages: true }),
      })),
    ];
    for (const { name, text } of everyLayer) {
      // `userValue` is the worst of them and the one a reader is most likely
      // to meet: it is the last stage, so it is where a mechanically perfect
      // run still fails.
      expect(text, name).not.toContain("userValue");
      expect(text, name).not.toContain("argumentMismatch");
      expect(text, name).not.toContain("notEstablished");
      expect(text, name).not.toContain("caseVariant");
      // The two the chain rows would have leaked.
      expect(text, name).not.toContain("notMeasured");
      expect(text, name).not.toContain("notApplicable");
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

  it("leads a non-pass with where the chain broke, above the per-trial detail", () => {
    // THE DEFAULT, not a flag. The verdict says what was decided and the
    // diagnostics headline says how much was measured; this says how far value
    // travelled before it stopped, and a reader who scrolls no further has it.
    const text = rendered.find(
      (row) => row.name === "measured-failure-at-every-stage"
    )!.text;
    const lines = text.split("\n");
    const headline = lines.findIndex((line) =>
      line.startsWith("  Diagnostics:")
    );
    const first = lines.findIndex((line) => line.startsWith("  First break:"));
    expect(first).toBe(headline + 1);
    // EARLIEST IN CHAIN ORDER, which is what "first" means everywhere else in
    // this contract — never "the most common". This fixture breaks once at
    // each of the six stages, so any other rule would pick a different one.
    expect(lines[first]).toContain("First break: Connection");
    expect(lines[first]).toContain(STAGE_REASON_LABELS.connectFailed);
    // And the count is what keeps that honest: one of six, and five other
    // stages also broke.
    expect(lines[first]).toContain("(1 of 6 measured trials");
    expect(lines[first]).toContain("earliest of 6 stages that broke");
  });

  it("never calls a partial page the RUN's first break", () => {
    // `earliest in chain order` is a claim about the rows in hand. On an
    // incomplete page an unlisted trial can have broken further up the chain,
    // so a reader told "First break: Response" would act on a stage the run
    // may not have stopped at. The diagnostics headline directly above already
    // refuses to present a page as the whole failure set; this line must not
    // undo that one line later.
    const partial = rendered.find(
      (row) => row.name === "partial-diagnostics-page"
    )!.text;
    expect(partial).toContain("PARTIAL");
    if (partial.includes("First break")) {
      expect(partial).toContain("First break ON THIS PAGE");
      expect(partial).not.toMatch(/ {2}First break: /);
    }
    // And the complete pages keep the unqualified claim.
    const complete = rendered.find(
      (row) => row.name === "measured-failure-at-every-stage"
    )!.text;
    expect(complete).toContain("  First break: Connection");
    expect(complete).not.toContain("ON THIS PAGE");
  });

  it("names the bucket when no measured trial reached a stage at all", () => {
    // A setup abort and an evaluator error carry a category and no stage. The
    // line must not invent a location for a run that never reached one.
    const text = rendered.find(
      (row) => row.name === "category-without-first-failed-stage"
    )!.text;
    expect(text).toContain(
      `  First break: no stage was reached — grouped under ${FAILURE_CATEGORY_LABELS.setup}, ${FAILURE_CATEGORY_LABELS.evaluator} (2 of 2 measured trials)`
    );
  });

  it("counts only the trials that actually carry a category", () => {
    // A readable chain can establish neither a stage nor a category. Folding
    // those into the count would attribute them to a bucket nothing put them
    // in — the same over-claim the spread clause avoids on the stage line.
    const base = byName("category-without-first-failed-stage").expected;
    const uncategorized = {
      ...base.diagnostics.items[0]!,
      iterationId: "it-3",
      iterationNumber: 3,
      chain: {
        status: "verified" as const,
        stages: [],
        analyzerVersion: STAGE_ANALYZER_VERSION,
      },
    };
    const text = formatEvalRunDecisionSummary({
      ...base,
      diagnostics: {
        ...base.diagnostics,
        items: [...base.diagnostics.items, uncategorized],
        scannedIterations: base.diagnostics.scannedIterations + 1,
      },
    });
    expect(text).toContain(
      `grouped under ${FAILURE_CATEGORY_LABELS.setup}, ${FAILURE_CATEGORY_LABELS.evaluator} (2 of 3 measured trials; 1 established no category)`
    );
  });

  it("says how many chains it could not read, beside the ones it could", () => {
    // Without this the denominator quietly shrinks to the trials that happened
    // to validate, and "1 of 1" is read as "all of them" on a run where half
    // the chains were withheld.
    const text = rendered.find(
      (row) => row.name === "unverified-and-version-ahead"
    )!.text;
    expect(text).toContain(
      "(1 of 1 measured trial; 1 more had no readable chain)"
    );
  });

  it("establishes no break when nothing in the run establishes one", () => {
    // A timed-out trial with neither a stage nor a category. Saying anything
    // here would be an invention; the diagnostics headline above already says
    // what was examined.
    const text = rendered.find(
      (row) => row.name === "inconclusive-no-gradeable-trials"
    )!.text;
    expect(text).not.toContain("First break:");
  });

  it("prints no chain line for a passing run", () => {
    expect(
      rendered.find((row) => row.name === "policyV2-passing")!.text
    ).not.toContain("First break:");
  });

  it("keeps the six chain rows behind the `stages` opt-in", () => {
    const summary = byName("measured-failure-at-every-stage").expected;
    const compact = formatEvalRunDecisionSummary(summary);
    const detailed = formatEvalRunDecisionSummary(summary, { stages: true });
    expect(compact).not.toContain("    Chain:");
    // Six rows per diagnostic, six diagnostics — the volume that has to stay
    // opt-in so existing callers' output does not grow underneath them.
    expect(detailed.split("\n").filter((l) => l === "    Chain:")).toHaveLength(
      6
    );
    expect(detailed).toContain(
      `      Connection: ${STAGE_STATE_LABELS.failed} — ${STAGE_REASON_LABELS.connectFailed}`
    );
    // A `notReached` row's state already says "an earlier stage failed"; the
    // reason must not repeat it back.
    expect(detailed).toContain(
      `      Discovery: ${STAGE_STATE_LABELS.notReached}\n`
    );
    // Every value through the label maps, on the detailed layer too.
    expect(detailed).not.toContain("notReached");
    expect(detailed).not.toContain("earlierStageFailed");
  });

  it("treats an inherited property name as an unknown member, not a label", () => {
    // The TYPE says these keys are closed; the runtime value came off the wire
    // and nothing on this path validates it. `labels[member]` alone resolves
    // `constructor`/`toString`/`valueOf` through `Object.prototype` to a
    // FUNCTION — truthy — and prints `function Object() { [native code] }` at
    // a human, which is the raw-enum failure in a worse costume.
    const withMember = (member: string): EvalRunDecisionSummary => ({
      ...byName("measured-failure-at-every-stage").expected,
      diagnostics: {
        complete: true,
        scannedIterations: 1,
        items: [
          {
            iterationId: "it-1",
            iterationNumber: 1,
            status: "completed",
            result: "failed",
            chain: {
              status: "verified",
              analyzerVersion: STAGE_ANALYZER_VERSION,
              stages: [
                {
                  stage: member,
                  state: member,
                  reason: member,
                } as unknown as EvalRunDecisionSummary["diagnostics"]["items"][number]["chain"] extends {
                  stages: (infer TRow)[];
                }
                  ? TRow
                  : never,
              ],
              firstFailedStage: member as unknown as "connection",
            },
            evidence: {
              runId: "run-1",
              iterationId: "it-1",
              tracePath: "/projects/p/eval-runs/run-1/iterations/it-1/trace",
            },
            nextAction:
              "inspect the case trace; no failure category was recorded",
          },
        ],
      },
    });

    for (const member of ["constructor", "toString", "valueOf", "__proto__"]) {
      for (const options of [{}, { stages: true }]) {
        const text = formatEvalRunDecisionSummary(withMember(member), options);
        expect(text, `${member} ${JSON.stringify(options)}`).not.toContain(
          "native code"
        );
        expect(text, `${member} ${JSON.stringify(options)}`).not.toContain(
          "function "
        );
      }
    }
  });

  it("names an unrecognized verdict, source or undecided reason instead of blanking it", () => {
    // Guarding the lookups stopped `function Object() { [native code] }` from
    // reaching a human, but a bare `?? ""` traded one broken sentence for
    // another: `Decision summary:  ()` and a naked `Why:` read as a rendering
    // bug rather than as a member this SDK predates. A vocabulary gaining a
    // member is the EXPECTED case — an agent reading `Why: judgeNewThing` can
    // go look it up, where a blank sends it nowhere.
    const base = byName("measured-failure-at-every-stage").expected;
    const text = formatEvalRunDecisionSummary({
      ...base,
      verdict: "verdictFromTheFuture" as unknown as typeof base.verdict,
      verdictSource:
        "sourceFromTheFuture" as unknown as typeof base.verdictSource,
      undecided: {
        reason: "reasonFromTheFuture",
      } as unknown as typeof base.undecided,
    });
    expect(text).toContain("verdictFromTheFuture");
    expect(text).toContain("sourceFromTheFuture");
    expect(text).toContain("Why: reasonFromTheFuture");
    // The specific malformations the `?? ""` fallbacks produced.
    expect(text).not.toContain("Decision summary:  ");
    expect(text.split("\n")).not.toContain("  Why: ");
    // An inherited property name is still not a member, and must not print
    // as one now that unknown members reach the page verbatim.
    for (const member of ["constructor", "toString", "valueOf"]) {
      const inherited = formatEvalRunDecisionSummary({
        ...base,
        verdict: member as unknown as typeof base.verdict,
        undecided: { reason: member } as unknown as typeof base.undecided,
      });
      expect(inherited, member).not.toContain("native code");
      expect(inherited, member).not.toContain("function ");
    }
  });

  it("prints no chain rows for a chain that was withheld or never recorded", () => {
    // `unverified` had its rows refused at the boundary and `absent` never had
    // any. Six "not measured" rows for either would state as measured-and-empty
    // exactly what was never measured.
    const detailed = formatEvalRunDecisionSummary(
      byName("unverified-and-version-ahead").expected,
      { stages: true }
    );
    expect(
      detailed.split("\n").filter((line) => line === "    Chain:")
    ).toHaveLength(1);
  });

  it("names the stage the evidence was read from", () => {
    const text = rendered.find(
      (row) => row.name === "measured-failure-at-every-stage"
    )!.text;
    expect(text).toContain("First failed stage: User value");
    expect(text).toContain("Evidence at Tool call:");
  });
});
