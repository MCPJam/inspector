/**
 * The verdict, the one sentence under it, and the numbers beside it.
 *
 * The page this replaces said "67%" in three places and never said which case
 * broke. The ordering here is the fix: a reader gets the DECISION first, then
 * one sentence naming the case and where its chain stopped, and only then the
 * measurements. A percentage is a measurement, so it sits with the other
 * measurements and never becomes the headline.
 *
 * ── What this module may and may not do ──────────────────────────────────────
 *
 * It reads a `EvalRunDecisionSummary` and renders it. It does not decide
 * anything: the verdict word comes from `summary.verdict`, the counts from
 * `summary.counts`, and the failing case from `diagnostics` — all of which the
 * contract already settled server-side. There is no arithmetic here that could
 * disagree with the decision it is describing.
 *
 * The one judgement it makes is WHICH diagnostic to lead with, and that is a
 * choice of what to show first, never a claim that the chosen one is the cause.
 * The sentence says "broke at <stage>" because a first failed stage is where
 * the chain stopped; it is not a diagnosis and must never be phrased as one.
 */
import {
  EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS,
  STAGE_REASON_LABELS,
  USER_VALUE_STAGE_LABELS,
  decisionDiagnosticFirstFailedStage,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
  type StageReason,
  type UserValueStage,
} from "@mcpjam/sdk/contract";

import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import { iterationLatencyP50, iterationLatencyP95 } from "../evals/helpers";

/**
 * The word at the top, and how loudly to say it.
 *
 * Deliberately NOT `EVAL_RUN_DECISION_VERDICT_LABELS`, which renders lowercase
 * fragments for splicing into a sentence ("no verdict established"). A headline
 * is not a fragment. The tone is separate from the word because `inconclusive`
 * and `notEstablished` are neither green nor red — painting either one red
 * reports a server defect the run never observed.
 */
export type HeroVerdictTone = "passed" | "failed" | "caution" | "neutral";

export type HeroVerdict = {
  word: string;
  tone: HeroVerdictTone;
  /**
   * Why nothing was decided, in words, when nothing was decided. Null on a run
   * that reached a verdict — an explanation beside a decision reads as a
   * caveat on the decision.
   */
  undecidedLine: string | null;
};

/** The diagnostic the hero leads with, and what it lets us say. */
export type HeroFocus = {
  diagnostic: EvalRunDecisionDiagnostic;
  /** Present only when the contract established a first failed stage. */
  stage: UserValueStage | null;
  reason: StageReason | null;
  /**
   * Why this diagnostic was chosen. `firstFailedStage` is the contract's own
   * answer; `firstWithReason` is a fallback for setup-abort and policy-block
   * shapes, where every stage reads "not measured" and there is no failed
   * stage to open — see the per-trial card rule this mirrors.
   */
  selectedBy: "firstFailedStage" | "firstWithReason" | "firstDiagnostic";
};

export type HeroSentence =
  | { kind: "brokeAt"; text: string; expected: string[]; observed: string[] }
  | { kind: "chainWithheld"; text: string }
  | { kind: "noFailure"; text: string }
  | { kind: "unavailable"; text: string };

/**
 * One measurement, with the population it measured stated on it.
 *
 * `unit` exists because "2 of 3" means two different things on the two verdict
 * sources, and a reader who takes a legacy run's trial count for a case count
 * has been told something false by a number that looked the same.
 */
export type HeroCaseStat =
  | { kind: "cases"; passed: number; total: number; inconclusive: number }
  | { kind: "trials"; passed: number | null; total: number | null }
  | { kind: "unavailable" };

export type HeroStats = {
  cases: HeroCaseStat;
  /** Always available: counted from the iteration rows this page already has. */
  iterations: { passed: number; total: number };
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  tokens: number | null;
  toolCalls: number | null;
};

export type RunVerdictHeroView = {
  verdict: HeroVerdict;
  focus: HeroFocus | null;
  sentence: HeroSentence;
  stats: HeroStats;
  /** True when the decision read is still in flight; the view stays honest meanwhile. */
  pending: boolean;
};

export type RunVerdictHeroInput = {
  run: EvalSuiteRun;
  iterations: readonly EvalIteration[];
  decision: {
    status: "disabled" | "loading" | "ready" | "error";
    summary: EvalRunDecisionSummary | null;
    diagnostics: readonly EvalRunDecisionDiagnostic[];
  };
};

/** Lifecycle statuses that are not a verdict and must not be painted as one. */
const RUN_STATUS_WORDS: Record<
  string,
  { word: string; tone: HeroVerdictTone }
> = {
  running: { word: "Running", tone: "neutral" },
  pending: { word: "Pending", tone: "neutral" },
  queued: { word: "Queued", tone: "neutral" },
  cancelled: { word: "Cancelled", tone: "neutral" },
  failed_to_start: { word: "Did not start", tone: "neutral" },
};

function verdictOf(input: RunVerdictHeroInput): HeroVerdict {
  const summary = input.decision.summary;
  if (summary) {
    switch (summary.verdict) {
      case "passed":
        return { word: "Passed", tone: "passed", undecidedLine: null };
      case "failed":
        return { word: "Failed", tone: "failed", undecidedLine: null };
      case "inconclusive":
        // Amber, never red. An inconclusive run measured too little to decide;
        // painting it as a failure reports a defect nobody observed.
        return { word: "Inconclusive", tone: "caution", undecidedLine: null };
      case "notEstablished":
        return {
          word: "No verdict",
          tone: "neutral",
          undecidedLine: summary.undecided
            ? EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS[
                summary.undecided.reason
              ]
            : null,
        };
    }
  }

  // No summary: fall back to the run's own LIFECYCLE status, and say it as a
  // lifecycle word. This is the loading, errored and flag-off path, and the
  // rule is that none of them may produce "Passed" or "Failed" — a verdict
  // this page has not read is a verdict it may not report.
  const status = String(input.run.status ?? "");
  const known = RUN_STATUS_WORDS[status];
  if (known) return { ...known, undecidedLine: null };
  return {
    word: "No verdict",
    tone: "neutral",
    undecidedLine:
      input.decision.status === "error"
        ? "the run's decision could not be read"
        : null,
  };
}

/**
 * Pick the diagnostic to lead with.
 *
 * Order matters and is the same one the per-trial cards use: the contract's own
 * `firstFailedStage` wins; failing that, the first row carrying a reason, which
 * is what a setup abort looks like; failing that, the first diagnostic at all,
 * so a run whose chains are all withheld still names a case.
 */
export function selectHeroFocus(
  diagnostics: readonly EvalRunDecisionDiagnostic[],
): HeroFocus | null {
  if (diagnostics.length === 0) return null;

  for (const diagnostic of diagnostics) {
    const stage = decisionDiagnosticFirstFailedStage(diagnostic);
    if (!stage) continue;
    if (diagnostic.chain.status !== "verified") continue;
    const row = diagnostic.chain.stages.find((entry) => entry.stage === stage);
    return {
      diagnostic,
      stage,
      reason: row?.reason ?? null,
      selectedBy: "firstFailedStage",
    };
  }

  for (const diagnostic of diagnostics) {
    if (diagnostic.chain.status !== "verified") continue;
    const row = diagnostic.chain.stages.find(
      (entry) => entry.reason !== undefined && entry.state !== "passed",
    );
    if (!row) continue;
    return {
      diagnostic,
      // Not a failed stage — only the row we are quoting. Naming it as the
      // break location would assert a failure the contract declined to.
      stage: null,
      reason: row.reason ?? null,
      selectedBy: "firstWithReason",
    };
  }

  return {
    diagnostic: diagnostics[0],
    stage: null,
    reason: null,
    selectedBy: "firstDiagnostic",
  };
}

const UNTITLED_CASE = "An untitled case";

function sentenceFor(
  input: RunVerdictHeroInput,
  verdict: HeroVerdict,
  focus: HeroFocus | null,
): HeroSentence {
  const { status, summary } = input.decision;
  if (status === "loading")
    return { kind: "unavailable", text: "Reading this run's decision…" };
  if (status === "error")
    return {
      kind: "unavailable",
      text: "This run's decision could not be read, so nothing is claimed about it here.",
    };
  if (status === "disabled" || !summary)
    return {
      kind: "unavailable",
      text: "",
    };

  if (!focus) {
    if (verdict.tone === "passed")
      return {
        kind: "noFailure",
        text: "Every case passed. Nothing needs attention on this run.",
      };
    // A failed or inconclusive run with no diagnostics is a real shape: the
    // page may hold none yet, or the run may have stopped before producing
    // any. Saying "nothing failed" here would contradict the verdict above.
    return {
      kind: "noFailure",
      text: "No non-passing iteration was returned for this run.",
    };
  }

  const title = focus.diagnostic.title?.trim() || UNTITLED_CASE;
  const expected = [...(focus.diagnostic.expected?.toolNames ?? [])];
  const observed = [...(focus.diagnostic.observed?.toolNames ?? [])];

  if (focus.stage && focus.reason) {
    return {
      kind: "brokeAt",
      text: `${title} broke at ${USER_VALUE_STAGE_LABELS[focus.stage]}: ${
        STAGE_REASON_LABELS[focus.reason]
      }.`,
      expected,
      observed,
    };
  }
  if (focus.stage) {
    return {
      kind: "brokeAt",
      text: `${title} broke at ${USER_VALUE_STAGE_LABELS[focus.stage]}.`,
      expected,
      observed,
    };
  }
  if (focus.reason) {
    // No first failed stage was established, so the sentence names the reason
    // WITHOUT a location. This is the setup-abort shape.
    return {
      kind: "brokeAt",
      text: `${title} did not complete: ${STAGE_REASON_LABELS[focus.reason]}.`,
      expected,
      observed,
    };
  }
  return {
    kind: "chainWithheld",
    text: `${title} did not pass, and its stage chain is not available, so where it broke is not established.`,
  };
}

function statsFor(input: RunVerdictHeroInput): HeroStats {
  const iterations = input.iterations;
  const passed = iterations.filter(
    (iteration) => iteration.result === "passed",
  ).length;

  let tokens: number | null = null;
  let toolCalls: number | null = null;
  for (const iteration of iterations) {
    if (typeof iteration.tokensUsed === "number") {
      tokens = (tokens ?? 0) + iteration.tokensUsed;
    }
    if (Array.isArray(iteration.actualToolCalls)) {
      toolCalls = (toolCalls ?? 0) + iteration.actualToolCalls.length;
    }
  }

  const counts = input.decision.summary?.counts;
  let cases: HeroCaseStat = { kind: "unavailable" };
  if (counts?.measurementUnit === "caseVariant") {
    cases = {
      kind: "cases",
      passed: counts.passed,
      total: counts.total,
      inconclusive: counts.inconclusive,
    };
  } else if (counts?.measurementUnit === "trial") {
    // A legacy run counts trials. Absent stays absent: a run that recorded no
    // total has not recorded a total of zero.
    cases = {
      kind: "trials",
      passed: counts.passed ?? null,
      total: counts.total ?? null,
    };
  }

  // The latency helpers take a mutable array and filter to completed rows
  // themselves, so the percentiles here describe the same population the rest
  // of the product reports.
  const latencyInput = [...iterations];
  return {
    cases,
    iterations: { passed, total: iterations.length },
    latencyP50Ms: iterationLatencyP50(latencyInput),
    latencyP95Ms: iterationLatencyP95(latencyInput),
    tokens,
    toolCalls,
  };
}

/** Build the whole hero view. Pure; every honest state is a value, not a throw. */
export function buildRunVerdictHero(
  input: RunVerdictHeroInput,
): RunVerdictHeroView {
  const verdict = verdictOf(input);
  const focus =
    input.decision.status === "ready"
      ? selectHeroFocus(input.decision.diagnostics)
      : null;
  return {
    verdict,
    focus,
    sentence: sentenceFor(input, verdict, focus),
    stats: statsFor(input),
    pending: input.decision.status === "loading",
  };
}
