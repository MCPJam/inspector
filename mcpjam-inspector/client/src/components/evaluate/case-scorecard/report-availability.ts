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
} from "@mcpjam/sdk/platform";

import { reportUnavailableMessage } from "@/components/shared/report-unavailability";

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
      line: reportUnavailableMessage(report.reason ?? "analysis_unavailable", "iteration"),
    };
  if (report.status === "stale")
    return {
      kind: "stale",
      line: "These explanations predate the latest grade.",
    };
  return { kind: "ready" };
}
