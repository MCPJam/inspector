import type { PlatformEvalIterationReportUnavailableReason } from "@mcpjam/sdk/platform";

/**
 * Total by construction: a reason the producer adds without a label here is a
 * compile error, and the producer narrows anything it does not know to
 * `analysis_unavailable`, so the wire cannot outrun this table at runtime.
 */
const UNAVAILABLE_LABELS: Record<
  PlatformEvalIterationReportUnavailableReason,
  (unit: "iteration" | "session") => string
> = {
  trace_too_large: (unit) => `This ${unit}'s trace was too large to analyze.`,
  context_too_large: (unit) =>
    `This ${unit}'s recorded failures were too large to analyze together.`,
  budget: (unit) =>
    `The analysis budget for this run was spent before this ${unit}.`,
  missing_trace: (unit) => `Nothing was recorded for this ${unit} to analyze.`,
  extraction_rejected: (unit) =>
    `The explanation this ${unit} produced could not be traced back to the recorded evidence, so it was discarded.`,
  analysis_unavailable: (unit) =>
    `AI explanations are unavailable for this ${unit}.`,
};

export function reportUnavailableMessage(
  reason: PlatformEvalIterationReportUnavailableReason,
  unit: "iteration" | "session",
): string {
  const label = Object.hasOwn(UNAVAILABLE_LABELS, reason)
    ? UNAVAILABLE_LABELS[reason]
    : UNAVAILABLE_LABELS.analysis_unavailable;
  return label(unit);
}
