/** Explicitly synthetic UI fixture; prose comes from the backend's pipeline fixture. */
import {
  USER_VALUE_STAGES,
  type EvalRunDecisionChain,
} from "@mcpjam/sdk/contract";
import { TrialChainPanel } from "@/components/evaluate/trial-chain-panel";
import { TrialScorecardRow } from "@/components/evaluate/case-scorecard/trial-scorecard-row";
import type { JoinedScorecardRow } from "@/components/evaluate/case-scorecard/trial-results";
import report from "@/components/shared/actionable-insights/__tests__/fixtures/trace-report-iteration.json";

const chain: EvalRunDecisionChain = {
  status: "verified",
  analyzerVersion: 1,
  firstFailedStage: "response",
  stages: USER_VALUE_STAGES.map((stage, index) => ({
    stage,
    state: index < 4 ? "passed" : index === 4 ? "failed" : "notReached",
    ...(index === 4
      ? { reason: "toolError" as const }
      : index > 4
      ? { reason: "earlierStageFailed" as const }
      : {}),
  })),
};
const row: JoinedScorecardRow = {
  key: "fixture-tool-error",
  stage: "response",
  provenance: "suite",
  label: "Tool response",
  kindLabel: "The tool returns a successful result.",
  role: "required",
  roleLock: "inherited",
  editable: false,
  tooltip: "Recorded response check",
  result: { state: "failed", source: "scoreRow", reason: "Unknown project ID" },
  narrative: {
    text: report.stageNotes[0].actual,
    citations: report.stageNotes[0].citations,
    stale: false,
  },
};
export function StageReportPreview() {
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer font-semibold">
        Stage report · synthetic fixture
      </summary>
      <div className="mt-4">
        <TrialChainPanel
          chain={chain}
          layout="report"
          stageFooter={(stage) =>
            stage === "response" ? (
              <ul className="mt-4">
                <TrialScorecardRow row={row} layout="report" />
              </ul>
            ) : null
          }
        />
      </div>
    </details>
  );
}
