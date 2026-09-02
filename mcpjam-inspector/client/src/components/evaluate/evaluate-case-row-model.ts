/**
 * One row per case: its verdict, its iterations, and where they broke.
 *
 * The old run page listed cases as a title, a segmented bar and two latency
 * columns — nothing about the chain, and two clicks from a trace. This model
 * builds the row the redesign needs, joining four sources that each know part
 * of the answer:
 *
 *   - the case GROUPS, which know which iterations belong together;
 *   - the D9 DIAGNOSTICS, which carry chains for non-passing iterations only;
 *   - the iteration CHAINS read, which carries chains for the rest;
 *   - the decision's `cases[]`, which knows each case's own verdict against its
 *     own threshold.
 *
 * ── The two claims this file is careful about ────────────────────────────────
 *
 * A MARK is a verdict and comes from `decision.cases[]` when the join lands.
 * When it does not — a legacy run, an identity we cannot mint, a variant
 * mismatch — the row says which of those happened and falls back to the
 * iteration outcome WITHOUT colouring it as a verdict. "2 of 3 iterations
 * passed" and "this case passed" are different sentences and the second needs a
 * threshold nobody has read.
 *
 * A BREAK COUNT is a tally of `firstFailedStage` over the chains actually
 * loaded. Both reads are page-capped, so a row states its coverage rather than
 * implying a stage was clean when its chain simply was not fetched.
 */
import {
  STAGE_REASON_LABELS,
  USER_VALUE_STAGES,
  decisionDiagnosticFirstFailedStage,
  evalCaseAggregationKey,
  type EvalRunDecisionChain,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
  type StageReason,
  type StageState,
  type UserValueStage,
} from "@mcpjam/sdk/contract";

import type { RunCaseGroup } from "../evals/run-case-groups";
import type { EvalIteration } from "../evals/types";
import { aggregationKeyForIteration } from "./evaluate-case-identity";

/** One case-variant's verdict, copied from the decision. Never recomputed. */
export type CaseVariantVerdict = {
  aggregationKey: string;
  verdict: "passed" | "failed" | "inconclusive";
  passedTrials: number;
  failedTrials: number;
  configuredTrials: number;
  effectivePassThreshold: number | null;
  mixedVerdict: boolean;
};

export type CaseRowVerdict =
  | { kind: "matched"; variants: CaseVariantVerdict[] }
  /** A legacy run has no per-case decision at all. Not a failure to join. */
  | { kind: "legacyRun" }
  | { kind: "noMatch" }
  | { kind: "identityNotEncodable" }
  | { kind: "notLoaded" };

export type CaseRowBreak =
  | { kind: "brokeAt"; stage: UserValueStage; reason: StageReason | null }
  | { kind: "noFailedStage"; reason: StageReason | null }
  | { kind: "withheld" }
  | { kind: "notLoaded" }
  | { kind: "none" };

/**
 * What one stage looked like across the iterations whose chains we hold.
 *
 * NOT just a break count. The first draft of this row painted every stage with
 * zero breaks green, which meant a case that stopped at Selection rendered
 * Call, Response and User value as passing — three stages it never reached.
 * That is the same over-claim the chip vocabulary exists to prevent, made by a
 * row of coloured squares instead of a word.
 */
export type StageCellState =
  | { kind: "failed"; count: number }
  | { kind: "passed"; count: number }
  /** Some iterations passed here and the rest never got this far. */
  | {
      kind: "partial";
      passed: number;
      /** Chains that stopped before this stage. */
      notReached: number;
      /** Chains that arrived and decided nothing. A different fact entirely. */
      notMeasured: number;
      notApplicable: number;
    }
  | { kind: "notReached"; count: number }
  | { kind: "notMeasured"; count: number }
  | { kind: "notApplicable"; count: number }
  | { kind: "notLoaded" };

export type CaseRowCoverage = {
  total: number;
  loaded: number;
  /** Iterations whose chain says a stage failed, tallied by that stage. */
  breaksByStage: Record<UserValueStage, number>;
  /** What each stage looked like across the loaded chains. */
  stageStates: Record<UserValueStage, StageCellState>;
  withheld: number;
  /** Set only when some chain was not loaded, so the row can say so in words. */
  note: string | null;
};

export type CaseRowIterationCell = {
  iterationId: string;
  outcome: "passed" | "failed" | "pending" | "cancelled";
  /** Where this one broke, when a chain for it was loaded. */
  stage: UserValueStage | null;
};

/**
 * Failing iterations of one case, grouped by what the chain says happened.
 *
 * Grouped rather than listed because the REASON is what a fix keys on: ten
 * iterations that all missed the same call are one piece of work and one
 * recommendation, while ten iterations failing for three different reasons are
 * three. Listing them per iteration would make the second look like the first.
 */
export type CaseFailureGroup = {
  key: string;
  stage: UserValueStage | null;
  reason: StageReason | null;
  iterationIds: string[];
  /** One iteration to show evidence from; the others share its shape. */
  representative: EvalRunDecisionDiagnostic | null;
};

export type EvaluateCaseRow = {
  key: string;
  title: string;
  testCaseId: string | null;
  /** The stored key, which is what the run comparison groups by. */
  caseKey: string | null;
  /** Counted from iteration rows. A population, never a verdict. */
  iterations: { passed: number; total: number };
  verdict: CaseRowVerdict;
  /** The verdict word to paint, or null when nothing decided this case. */
  mark: "passed" | "failed" | "inconclusive" | null;
  break: CaseRowBreak;
  cells: CaseRowIterationCell[];
  coverage: CaseRowCoverage;
  p50Ms: number | null;
  /** The iteration a reader should be taken to, and the one that opens. */
  opensIterationId: string | null;
  diagnostic: EvalRunDecisionDiagnostic | null;
  failureGroups: CaseFailureGroup[];
};

export type BuildCaseRowsInput = {
  groups: readonly RunCaseGroup[];
  summary: EvalRunDecisionSummary | null;
  diagnostics: readonly EvalRunDecisionDiagnostic[];
  chains: ReadonlyMap<string, EvalRunDecisionChain>;
  /** False while either chain source is still arriving. */
  chainsLoaded: boolean;
  decisionStatus: "disabled" | "loading" | "ready" | "error";
};

function emptyBreaks(): Record<UserValueStage, number> {
  return USER_VALUE_STAGES.reduce((acc, stage) => {
    acc[stage] = 0;
    return acc;
  }, {} as Record<UserValueStage, number>);
}

function outcomeOf(iteration: EvalIteration): CaseRowIterationCell["outcome"] {
  if (iteration.result === "passed") return "passed";
  if (iteration.result === "failed" || iteration.result === "timed_out")
    return "failed";
  if (iteration.result === "cancelled") return "cancelled";
  return "pending";
}

/**
 * The verdict rows of a policy-v2 decision, keyed the way the backend keys them.
 *
 * Returns null for a legacy run, which HAS no case rows — a distinct answer
 * from "we looked and found none".
 */
function indexVerdictCases(summary: EvalRunDecisionSummary | null): {
  byKey: Map<string, CaseVariantVerdict>;
  variantKeyed: Set<string>;
} | null {
  const decision = summary?.decision;
  if (!decision) return null;

  const byKey = new Map<string, CaseVariantVerdict>();
  const variantKeyed = new Set<string>();
  for (const entry of decision.cases) {
    // The contract's own key function, used on BOTH sides of this join. Its
    // separator is NUL precisely so that no two distinct identities collide by
    // concatenation, and a hand-rolled delimiter here would never match.
    const aggregationKey = evalCaseAggregationKey({
      caseId: entry.caseId,
      ...(entry.executionVariant
        ? { executionVariant: entry.executionVariant }
        : {}),
    });
    if (entry.executionVariant) variantKeyed.add(entry.caseId);
    byKey.set(aggregationKey, {
      aggregationKey,
      verdict: entry.verdict,
      passedTrials: entry.passedTrials,
      failedTrials: entry.failedTrials,
      configuredTrials: entry.configuredTrials,
      effectivePassThreshold: entry.effectivePassThreshold ?? null,
      mixedVerdict: Boolean(entry.mixedVerdict),
    });
  }
  return { byKey, variantKeyed };
}

function chainFor(
  iterationId: string,
  diagnosticsByIteration: Map<string, EvalRunDecisionDiagnostic>,
  chains: ReadonlyMap<string, EvalRunDecisionChain>,
): EvalRunDecisionChain | null {
  const diagnostic = diagnosticsByIteration.get(iterationId);
  if (diagnostic) return diagnostic.chain;
  return chains.get(iterationId) ?? null;
}

function breakFromChain(chain: EvalRunDecisionChain | null): CaseRowBreak {
  if (!chain) return { kind: "notLoaded" };
  if (chain.status !== "verified") return { kind: "withheld" };

  const stage = chain.firstFailedStage;
  if (stage) {
    const row = chain.stages.find((entry) => entry.stage === stage);
    return { kind: "brokeAt", stage, reason: row?.reason ?? null };
  }
  // No failed stage established. A setup abort looks like this, and calling
  // the row we read a reason off "the break" would assert a stage failure the
  // contract declined to.
  const reasoned = chain.stages.find(
    (entry) => entry.reason !== undefined && entry.state !== "passed",
  );
  if (reasoned)
    return { kind: "noFailedStage", reason: reasoned.reason ?? null };
  return { kind: "none" };
}

/**
 * One stage's cell, from the states every loaded chain reported for it.
 *
 * The break count wins the cell when there is one, because that is what a
 * reader is looking for. Otherwise the states decide, and `partial` exists so
 * that "seven iterations passed here and three never arrived" is not rounded up
 * to green or down to grey — both would be false about most of them.
 */
function summarizeStage(
  states: readonly StageState[] | undefined,
  breaks: number,
): StageCellState {
  if (breaks > 0) return { kind: "failed", count: breaks };
  if (!states || states.length === 0) return { kind: "notLoaded" };

  const tally = { passed: 0, notReached: 0, notMeasured: 0, notApplicable: 0 };
  for (const state of states) {
    if (state === "passed") tally.passed += 1;
    else if (state === "notReached") tally.notReached += 1;
    else if (state === "notApplicable") tally.notApplicable += 1;
    else tally.notMeasured += 1;
  }

  if (tally.passed === states.length) {
    return { kind: "passed", count: tally.passed };
  }
  if (tally.notReached === states.length) {
    return { kind: "notReached", count: tally.notReached };
  }
  if (tally.notApplicable === states.length) {
    return { kind: "notApplicable", count: tally.notApplicable };
  }
  if (tally.passed === 0) {
    return { kind: "notMeasured", count: states.length };
  }
  // The three non-passing shapes are kept apart rather than summed into one
  // "never reached it": a chain that arrived and decided nothing is a
  // different fact from one that stopped before this stage, and a stage the
  // case never asserted is a third.
  return {
    kind: "partial",
    passed: tally.passed,
    notReached: tally.notReached,
    notMeasured: tally.notMeasured,
    notApplicable: tally.notApplicable,
  };
}

/** Rank for sorting. Failures first, then anything undecided, then passes. */
function sortRank(row: EvaluateCaseRow): number {
  if (row.mark === "failed") return 0;
  if (row.mark === "inconclusive") return 1;
  if (row.mark === null)
    return row.iterations.passed < row.iterations.total ? 2 : 3;
  return 4;
}

export function buildEvaluateCaseRows(
  input: BuildCaseRowsInput,
): EvaluateCaseRow[] {
  const verdictIndex = indexVerdictCases(input.summary);
  const diagnosticsByIteration = new Map(
    input.diagnostics.map((item) => [item.iterationId, item]),
  );

  const rows = input.groups.map((group): EvaluateCaseRow => {
    const cells: CaseRowIterationCell[] = [];
    const breaksByStage = emptyBreaks();
    let loaded = 0;
    let withheld = 0;

    // Per stage, the states every loaded chain reported there. Aggregated from
    // the rows themselves rather than inferred from the break counts, so a
    // stage nobody reached cannot come out looking like one that passed.
    const observed = USER_VALUE_STAGES.reduce((acc, stage) => {
      acc[stage] = [];
      return acc;
    }, {} as Record<UserValueStage, StageState[]>);

    for (const iteration of group.iterations) {
      const chain = chainFor(
        iteration._id,
        diagnosticsByIteration,
        input.chains,
      );
      if (chain) loaded += 1;
      if (chain && chain.status !== "verified") withheld += 1;
      const stage =
        chain && chain.status === "verified"
          ? chain.firstFailedStage ?? null
          : null;
      if (stage) breaksByStage[stage] += 1;
      if (chain && chain.status === "verified") {
        for (const row of chain.stages) {
          observed[row.stage]?.push(row.state);
        }
      }
      cells.push({
        iterationId: iteration._id,
        outcome: outcomeOf(iteration),
        stage,
      });
    }

    const stageStates = USER_VALUE_STAGES.reduce((acc, stage) => {
      acc[stage] = summarizeStage(observed[stage], breaksByStage[stage]);
      return acc;
    }, {} as Record<UserValueStage, StageCellState>);

    // Which iteration opens: the first failing one whose chain explains it,
    // then the first failing one at all, then the first iteration.
    const failing = group.iterations.filter(
      (iteration) => outcomeOf(iteration) === "failed",
    );
    const explained = failing.find((iteration) => {
      const diagnostic = diagnosticsByIteration.get(iteration._id);
      return diagnostic
        ? Boolean(decisionDiagnosticFirstFailedStage(diagnostic))
        : false;
    });
    const opens = explained ?? failing[0] ?? group.iterations[0] ?? null;
    const opensId = opens?._id ?? null;

    let verdict: CaseRowVerdict = { kind: "notLoaded" };
    if (input.decisionStatus === "ready") {
      if (!verdictIndex) {
        // A LEGACY run counts trials and has no case rows by design. A run
        // whose source is `none` established no verdict at all, which is a
        // different sentence, so it is not filed under the legacy one.
        verdict =
          input.summary?.verdictSource === "legacy"
            ? { kind: "legacyRun" }
            : { kind: "notLoaded" };
      } else {
        const variants: CaseVariantVerdict[] = [];
        let anyCandidate = false;
        for (const iteration of group.iterations) {
          const candidates = aggregationKeyForIteration(
            iteration,
            verdictIndex.variantKeyed,
            (key) => verdictIndex.byKey.has(key),
          );
          if (candidates === null) continue;
          anyCandidate = true;
          const entry = verdictIndex.byKey.get(candidates.aggregationKey);
          if (
            entry &&
            !variants.some((row) => row.aggregationKey === entry.aggregationKey)
          ) {
            variants.push(entry);
          }
        }
        verdict = anyCandidate
          ? { kind: "matched", variants }
          : group.iterations.some(
              (iteration) =>
                (iteration.testCaseSnapshot?.caseKey ??
                  iteration.testCaseId) !== undefined,
            )
          ? { kind: "noMatch" }
          : { kind: "identityNotEncodable" };
      }
    }

    // The mark is a verdict, so it only exists when a verdict was read. A row
    // with variants that disagree gets no single mark: reporting one of them
    // would hide the other.
    let mark: EvaluateCaseRow["mark"] = null;
    if (verdict.kind === "matched" && verdict.variants.length > 0) {
      const distinct = new Set(verdict.variants.map((row) => row.verdict));
      mark = distinct.size === 1 ? verdict.variants[0].verdict : null;
    }

    const openChain = opensId
      ? chainFor(opensId, diagnosticsByIteration, input.chains)
      : null;

    // Group the failing iterations by (stage, reason). A group with neither is
    // still a group — "failed with no chain loaded" is a real and common shape.
    const groupsByKey = new Map<string, CaseFailureGroup>();
    for (const iteration of group.iterations) {
      if (outcomeOf(iteration) !== "failed") continue;
      const chain = chainFor(
        iteration._id,
        diagnosticsByIteration,
        input.chains,
      );
      const shape = breakFromChain(chain);
      const stage = shape.kind === "brokeAt" ? shape.stage : null;
      const reason =
        shape.kind === "brokeAt" || shape.kind === "noFailedStage"
          ? shape.reason
          : null;
      const key = `${stage ?? "none"}::${reason ?? shape.kind}`;
      const existing = groupsByKey.get(key);
      if (existing) {
        existing.iterationIds.push(iteration._id);
        continue;
      }
      groupsByKey.set(key, {
        key,
        stage,
        reason,
        iterationIds: [iteration._id],
        representative: diagnosticsByIteration.get(iteration._id) ?? null,
      });
    }

    const note =
      loaded < group.iterations.length
        ? `chains loaded for ${loaded} of ${group.iterations.length} iterations`
        : null;

    return {
      key: group.key,
      title: group.title,
      testCaseId: group.testCaseId,
      caseKey:
        group.iterations.find(
          (iteration) => iteration.testCaseSnapshot?.caseKey !== undefined,
        )?.testCaseSnapshot?.caseKey ?? null,
      iterations: { passed: group.passed, total: group.total },
      verdict,
      mark,
      break: breakFromChain(openChain),
      cells,
      coverage: {
        total: group.iterations.length,
        loaded,
        breaksByStage,
        stageStates,
        withheld,
        note,
      },
      p50Ms: group.p50Ms,
      opensIterationId: opensId,
      diagnostic: opensId ? diagnosticsByIteration.get(opensId) ?? null : null,
      // Largest group first: the shape that broke most iterations is the one
      // worth reading first.
      failureGroups: [...groupsByKey.values()].sort(
        (a, b) => b.iterationIds.length - a.iterationIds.length,
      ),
    };
  });

  return rows.sort((a, b) => {
    const rank = sortRank(a) - sortRank(b);
    return rank !== 0 ? rank : a.title.localeCompare(b.title);
  });
}

/** The row that should be open when the page loads, if any. */
export function defaultOpenCaseRow(
  rows: readonly EvaluateCaseRow[],
): string | null {
  const failing = rows.find((row) => row.mark === "failed");
  if (failing) return failing.key;
  const brokeSomewhere = rows.find((row) => row.break.kind === "brokeAt");
  return brokeSomewhere?.key ?? null;
}

/** The reason label for a row's break, or null. Kept off chips by design. */
export function caseRowReasonLabel(row: EvaluateCaseRow): string | null {
  const reason =
    row.break.kind === "brokeAt" || row.break.kind === "noFailedStage"
      ? row.break.reason
      : null;
  return reason ? STAGE_REASON_LABELS[reason] : null;
}
