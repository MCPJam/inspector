/**
 * What the scorecard says about the AI narrative it does not have.
 *
 * Four states a reader can tell apart, because the next step differs in each:
 * nobody has analyzed this run, the read phase has not reached this iteration yet,
 * something specific stopped it, or the narrative predates the current grade.
 * Silence used to cover the first three, which is how a 1,000-iteration run in
 * progress looked identical to one nobody had ever analyzed.
 *
 * Deterministic content — EXPECTED, the recorded ACTUAL, the verdict — never
 * depends on any of this. It is on the page in every state, including
 * `unavailable`.
 */
import type {
  PlatformEvalIterationReport,
  PlatformEvalIterationReportUnavailableReason,
} from "@mcpjam/sdk/platform";

/**
 * Total by construction: a reason the producer adds without a label here is a
 * compile error, and the producer narrows anything it does not know to
 * `analysis_unavailable`, so the wire cannot outrun this table at runtime.
 */
const UNAVAILABLE_LABELS: Record<
  PlatformEvalIterationReportUnavailableReason,
  string
> = {
  trace_too_large: "This iteration's trace was too large to analyze.",
  context_too_large:
    "This iteration's recorded failures were too large to analyze together.",
  budget: "The analysis budget for this run was spent before this iteration.",
  missing_trace: "Nothing was recorded for this iteration to analyze.",
  extraction_rejected:
    "The explanation this iteration produced could not be traced back to the recorded evidence, so it was discarded.",
  analysis_unavailable: "AI explanations are unavailable for this iteration.",
};

export type ReportAvailability =
  | { kind: "ready" }
  | { kind: "none"; line: string }
  | { kind: "pending"; line: string }
  | { kind: "unavailable"; line: string }
  | { kind: "stale"; line: string };

export function reportAvailability(
  report: PlatformEvalIterationReport | null | undefined,
  options: { runSettled: boolean },
): ReportAvailability {
  // A running iteration is not missing an explanation; it has not finished
  // running. The scorecard's own in-progress state covers that.
  if (!report)
    return options.runSettled
      ? {
          kind: "none",
          line: "Analyze this run to add AI explanations to these rows.",
        }
      : { kind: "ready" };
  if (report.status === "pending")
    return {
      kind: "pending",
      line: report.progress
        ? `Reading iterations ${report.progress.done} of ${report.progress.total}…`
        : "Reading this run's iterations…",
    };
  if (report.status === "failed")
    return {
      kind: "unavailable",
      line: UNAVAILABLE_LABELS[report.reason ?? "analysis_unavailable"],
    };
  if (report.status === "stale")
    return {
      kind: "stale",
      line: "These explanations predate the latest grade.",
    };
  return { kind: "ready" };
}
