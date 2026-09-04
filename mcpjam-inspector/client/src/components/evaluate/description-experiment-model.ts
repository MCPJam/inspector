/**
 * Presentation helpers for the description-experiment card.
 *
 * No fetching, no DOM. The card and the propose button both read these so
 * a header line and an engine gate cannot drift apart.
 */
import type { DescriptionExperimentInterval } from "@mcpjam/sdk/contract";

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
 * never silently launched. An unrecorded engine is treated as emulated:
 * those runs predate attribution and went through the platform loop.
 */
export function isEmulatedDescriptionExperimentEngine(
  engine: string | undefined,
): boolean {
  return !engine || engine === "emulated";
}

export function catalogToolNamesFromRun(run: EvalSuiteRun): Set<string> {
  const catalog = readRunToolCatalog(run);
  return catalog.state === "loaded"
    ? new Set(catalog.toolNames)
    : new Set();
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
 * The bound that matters, in points. Never a number when `interval` is
 * null — that is the card's one hard rule.
 */
export function intervalBoundPhrase(
  interval: DescriptionExperimentInterval | null,
): string {
  if (interval === null) return "not enough trials to say";
  if (interval.deltaPoints > 0) {
    return `at least ${signedPoints(interval.lowerPoints)} points`;
  }
  if (interval.deltaPoints < 0) {
    return `at most ${signedPoints(interval.upperPoints)} points`;
  }
  return "no difference in points";
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

export function maxTrialsCapOf(
  experiment: EvalDescriptionExperiment,
): number {
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
  const parts = [
    "Description experiment",
    `\`${experiment.toolName}\``,
  ];
  const report = experiment.report;
  if (report) {
    const { original, rewrite, interval } = report.primary.pooled;
    parts.push(
      `rewrite passed ${rewrite.passed} of ${rewrite.eligible}, original ${original.passed} of ${original.eligible}`,
    );
    parts.push(intervalBoundPhrase(interval));
    parts.push(
      report.evidenceLabel === "controlled" ? "Controlled" : "Reproducible",
    );
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
    const names = regression.regressed.map(caseLabelFromAggregationKey).join(", ");
    return n === 0
      ? "Other cases flipped on the rewrite arm."
      : `${n} other ${n === 1 ? "case" : "cases"} flipped: ${names}`;
  }
  if (regression.status === "non_gateable") {
    return regression.reason ?? "Regression could not be gated.";
  }
  return "No other case flipped.";
}

export function evidenceCaveat(
  label: "controlled" | "reproducible",
): string {
  if (label === "controlled") {
    return "Every eligible trial had a fresh computer. The upstream server's state was not verified.";
  }
  return "The two arms ran in the same window with frozen model, engine, host, and catalog. The upstream server's state was not verified.";
}
