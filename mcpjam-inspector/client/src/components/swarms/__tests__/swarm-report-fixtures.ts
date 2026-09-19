import {
  assembleSwarmReport,
  deriveSwarmSessionVerdict,
} from "@mcpjam/sdk/contract";
export function neverStartedReport(count: number) {
  return assembleSwarmReport({
    runId: "run",
    configuredSessions: count,
    executionComplete: true,
    verdictSummary: null,
    evaluatorDefinitions: [],
    sessions: Array.from({ length: count }, (_, i) => ({
      id: `slot-${i}`,
      startEvidence: "notStarted",
      observations: [],
      verdict: deriveSwarmSessionVerdict({
        attempt: { status: "failed", errorCode: "stale_runner" },
        hasTranscript: false,
        rubric: [],
        criteria: null,
        goalScore: null,
        judge: { automatic: true, role: "advisory" },
        grading: { state: "notRequested" },
      }),
    })),
  });
}
