import type { SwarmFindingCoverageNote } from "@mcpjam/sdk/contract";
import type { PlatformEvalIterationReportUnavailableReason } from "@mcpjam/sdk/platform";
import { reportUnavailableMessage } from "@/components/shared/report-unavailability";

const REPORT_REASONS: Partial<
  Record<SwarmFindingCoverageNote, PlatformEvalIterationReportUnavailableReason>
> = {
  budgetExhausted: "budget",
  transcriptMissing: "missing_trace",
  contextTooLarge: "context_too_large",
  extractionRejected: "extraction_rejected",
  analysisUnavailable: "analysis_unavailable",
};

/** Session notes describe report availability. Wave notes can describe grouping. */
export function sessionReportUnavailableMessage(
  notes: readonly SwarmFindingCoverageNote[],
): string | undefined {
  const reason = notes.map((note) => REPORT_REASONS[note]).find(Boolean);
  return reason ? reportUnavailableMessage(reason, "session") : undefined;
}
