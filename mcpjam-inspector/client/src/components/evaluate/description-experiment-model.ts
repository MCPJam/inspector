/**
 * Presentation helpers for the description-experiment card.
 *
 * No fetching, no DOM. The card and the propose button both read these so
 * a header line and an engine gate cannot drift apart.
 */
import type {
  DescriptionExperimentEvidenceLabel,
  DescriptionExperimentFrozen,
  DescriptionExperimentPooled,
} from "@mcpjam/sdk/contract";

import type { EvalDescriptionExperiment } from "@/lib/apis/eval-description-experiment-api";
import type { EvalSuiteRun } from "../evals/types";
import { readRunToolCatalog } from "./route-facts-model";

/**
 * The run's recorded engine, if any.
 *
 * Top-level wins (API-projected rows), then the snapshot. Absence is
 * UNKNOWN — not emulated — and the caller decides how to treat it.
 */
export function readRunExecutionEngine(
  run: Pick<EvalSuiteRun, "executionEngine" | "configSnapshot">,
): string | undefined {
  if (typeof run.executionEngine === "string" && run.executionEngine) {
    return run.executionEngine;
  }
  const snap = run.configSnapshot?.executionEngine;
  if (typeof snap === "string" && snap) return snap;
  return undefined;
}

/**
 * v1 of the experiment is emulated-only. `claude-code`, `cursor`,
 * `codex`, `mixed`, and any `harness:<id>` are refused at the button,
 * never silently launched. An unrecorded engine is UNKNOWN, and unknown
 * is refused too: a pre-attribution row says nothing about which loop ran
 * it, and the button must not guess.
 */
export function isEmulatedDescriptionExperimentEngine(
  engine: string | undefined,
): boolean {
  return engine === "emulated";
}

export function catalogToolNamesFromRun(run: EvalSuiteRun): Set<string> {
  const catalog = readRunToolCatalog(run);
  return catalog.state === "loaded" ? new Set(catalog.toolNames) : new Set();
}

export function hash8(value: string | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 8);
}

export function caseLabelFromAggregationKey(key: string): string {
  const nul = key.indexOf("\u0000");
  return nul === -1 ? key : key.slice(0, nul) || key;
}

/**
 * The bound that matters, in points. Branches on the report's VERDICT, not
 * on the sign of the point estimate: an interval that straddles zero, or a
 * delta under the effect floor, is `no_difference` however the delta leans,
 * and phrasing a bound off it would claim a direction the report did not.
 * Never a number when `interval` is null — that is the card's one hard rule.
 */
export function intervalBoundPhrase(
  pooled: Pick<DescriptionExperimentPooled, "verdict" | "interval">,
): string {
  const { verdict, interval } = pooled;
  if (verdict === "insufficient_data" || interval === null) {
    return "not enough trials to say";
  }
  switch (verdict) {
    case "improved":
      return `at least ${signedPoints(interval.lowerPoints)} points`;
    case "regressed":
      return `at most ${signedPoints(interval.upperPoints)} points`;
    case "no_difference":
      return "no difference at this sample size";
  }
}

/** The report's own label, worded. Never derived from `frozen` here. */
export function evidenceLabelText(
  label: DescriptionExperimentEvidenceLabel,
): string {
  return label === "controlled" ? "Controlled" : "Reproducible";
}

/**
 * "arms differ: toolSnapshotHash, hostConfigId", or null when the report
 * found the arms equal. Order is the report's.
 */
export function frozenDifferencesLabel(
  frozen: Pick<DescriptionExperimentFrozen, "equal" | "differences">,
): string | null {
  if (frozen.equal || !frozen.differences || frozen.differences.length === 0) {
    return null;
  }
  return `arms differ: ${frozen.differences.join(", ")}`;
}

function signedPoints(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

export function plannedTrialsOf(
  experiment: EvalDescriptionExperiment,
): number | null {
  if (typeof experiment.plan?.plannedTrials === "number") {
    return experiment.plan.plannedTrials;
  }
  const cases = experiment.affectedCaseIds?.length;
  const reps = experiment.plan?.repetitions;
  if (cases && reps) return cases * reps * 2;
  return null;
}

export function maxTrialsCapOf(experiment: EvalDescriptionExperiment): number {
  return experiment.plan?.maxTrials ?? 200;
}

/**
 * Collapsed header. Examples:
 * - "Description experiment · `get_user` · rewrite passed 8 of 10, original 3 of 10 · at least +12 points · Reproducible · report-only"
 * - "… · not enough trials to say"
 */
export function descriptionExperimentHeader(
  experiment: EvalDescriptionExperiment,
): string {
  const parts = ["Description experiment", `\`${experiment.toolName}\``];
  const report = experiment.report;
  if (report) {
    const { original, rewrite } = report.primary.pooled;
    parts.push(
      `rewrite passed ${rewrite.passed} of ${rewrite.eligible}, original ${original.passed} of ${original.eligible}`,
    );
    parts.push(intervalBoundPhrase(report.primary.pooled));
    parts.push(evidenceLabelText(report.evidenceLabel));
    parts.push("report-only");
    return parts.join(" · ");
  }

  switch (experiment.status) {
    case "proposing":
      parts.push("drafting a rewrite");
      break;
    case "proposed":
      parts.push("rewrite ready");
      break;
    case "launching":
    case "running":
    case "reporting":
      parts.push("running");
      break;
    case "failed":
      parts.push(experiment.errorCode ?? "failed");
      break;
    case "cancelled":
      parts.push("cancelled");
      break;
    case "completed":
      parts.push("report not ready");
      break;
    default:
      break;
  }
  return parts.join(" · ");
}

export function regressionLine(
  experiment: EvalDescriptionExperiment,
): string | null {
  const regression = experiment.report?.regression;
  if (!regression) return null;
  if (!regression.checked) {
    return (
      regression.reason ??
      "Regression was not checked — this launch replayed only the affected cases."
    );
  }
  if (regression.status === "failed") {
    const n = regression.regressed.length;
    const names = regression.regressed
      .map(caseLabelFromAggregationKey)
      .join(", ");
    return n === 0
      ? "Other cases flipped on the rewrite arm."
      : `${n} other ${n === 1 ? "case" : "cases"} flipped: ${names}`;
  }
  if (regression.status === "non_gateable") {
    return regression.reason ?? "Regression could not be gated.";
  }
  return "No other case flipped.";
}

type FrozenForCaveat = Pick<
  DescriptionExperimentFrozen,
  "equal" | "differences"
> &
  Partial<
    Pick<
      DescriptionExperimentFrozen,
      | "model"
      | "engine"
      | "hostConfigId"
      | "toolSnapshotHash"
      | "judgeConfigHash"
    >
  >;

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Which of the five frozen variables the report actually recorded — the
 * contract's `DESCRIPTION_EXPERIMENT_FROZEN_FIELDS`, in its order, with the
 * judge config read as "grader". A scalar is present only when both arms
 * agree on it and the builder had it; an absent one is "not recorded",
 * never "frozen".
 */
export function frozenFieldsLabel(frozen: FrozenForCaveat): string {
  const recorded: string[] = [];
  const missing: string[] = [];
  (frozen.model && frozen.model.length > 0 ? recorded : missing).push("model");
  (frozen.engine ? recorded : missing).push("engine");
  (frozen.hostConfigId ? recorded : missing).push("host");
  (frozen.toolSnapshotHash ? recorded : missing).push("catalog");
  (frozen.judgeConfigHash ? recorded : missing).push("grader");
  const frozenPart =
    recorded.length > 0 ? ` with frozen ${joinNames(recorded)}` : "";
  const missingPart =
    missing.length > 0 ? `; ${joinNames(missing)} not recorded` : "";
  return `${frozenPart}${missingPart}`;
}

/**
 * Why the report gave the label it gave. Reads the label and the frozen
 * block as the report wrote them; the label is never recomputed here, and
 * only the fields the report carries are called frozen.
 */
export function evidenceCaveat(
  label: DescriptionExperimentEvidenceLabel,
  frozen?: FrozenForCaveat,
): string {
  const unverified = "The upstream server's state was not verified.";
  if (label === "controlled") {
    return `Every eligible trial had a fresh computer and the two arms matched on every frozen variable. ${unverified}`;
  }
  const differed = frozen ? frozenDifferencesLabel(frozen) : null;
  if (differed) {
    return `The two arms ran in the same window, but ${differed.replace(
      "arms differ: ",
      "they differed on ",
    )} — the report calls this reproducible, not controlled. ${unverified}`;
  }
  const fields = frozen
    ? frozenFieldsLabel(frozen)
    : "; model, engine, host, catalog, and grader not recorded";
  return `The two arms ran in the same window${fields}. ${unverified}`;
}
