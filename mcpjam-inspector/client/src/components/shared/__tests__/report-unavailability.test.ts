import { describe, expect, it } from "vitest";
import { reportUnavailableMessage } from "../report-unavailability";
import { sessionReportUnavailableMessage } from "../../swarms/findings/findings-report-availability";

describe("shared report availability", () => {
  it.each([
    ["budgetExhausted", "budget"],
    ["transcriptMissing", "missing_trace"],
    ["contextTooLarge", "context_too_large"],
    ["extractionRejected", "extraction_rejected"],
    ["analysisUnavailable", "analysis_unavailable"],
  ] as const)("uses the same reason for %s", (note, reason) => {
    expect(sessionReportUnavailableMessage([note])).toBe(
      reportUnavailableMessage(reason, "session"),
    );
    expect(reportUnavailableMessage(reason, "iteration")).toContain(
      "iteration",
    );
  });

  it("keeps partial coverage distinct from a recorded failure", () => {
    expect(sessionReportUnavailableMessage(["partialRead"])).toBeUndefined();
  });
});
