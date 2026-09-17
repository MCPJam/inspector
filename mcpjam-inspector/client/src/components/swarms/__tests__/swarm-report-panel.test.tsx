import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  assembleSwarmReport,
  deriveSwarmSessionVerdict,
} from "@mcpjam/sdk/contract";
import { SwarmGoalResult, SwarmReportPanel } from "../swarm-report-panel";
import { lifecycleChip, verdictBadge } from "../swarm-verdict-presentation";
const verdict = (passed: boolean) =>
  deriveSwarmSessionVerdict({
    attempt: { status: "failed" },
    hasTranscript: true,
    rubric: [],
    criteria: null,
    goalScore: { status: "completed", passed },
    judge: { automatic: true, role: "advisory" },
    grading: { state: "settled" },
  });
describe("swarm reporting presentation", () => {
  it("renders a passed goal independently from interrupted execution", () => {
    const v = verdict(true);
    expect(lifecycleChip(v.lifecycle).label).toBe("Broke");
    render(<SwarmGoalResult verdict={v} />);
    expect(screen.getByText("Goal result: Passed")).toBeInTheDocument();
  });
  it("shows execution coverage without claiming an ungraded run never ran", () => {
    const report = assembleSwarmReport({
      runId: "run",
      configuredSessions: 1,
      executionComplete: true,
      verdictSummary: null,
      evaluatorDefinitions: [],
      sessions: [
        {
          id: "session",
          startEvidence: "started",
          verdict: verdict(true),
          observations: [],
        },
      ],
    });
    render(<SwarmReportPanel report={report} />);
    expect(screen.getByText(/1\/1 sessions started/)).toBeInTheDocument();
    expect(screen.getByText(/Goal grading: 1 passed/)).toBeInTheDocument();
    expect(
      screen.getByText("Run decision: Not established"),
    ).toBeInTheDocument();
  });
  it("distinguishes waiting, unavailable, and deliberately absent grades", () => {
    const base = {
      attempt: { status: "succeeded" as const },
      hasTranscript: true,
      rubric: [],
      criteria: null,
      goalScore: null,
      judge: { automatic: true, role: "advisory" as const },
    };
    expect(
      verdictBadge(
        deriveSwarmSessionVerdict({ ...base, grading: { state: "queued" } }),
      ).label,
    ).toBe("Grading");
    expect(
      verdictBadge(
        deriveSwarmSessionVerdict({
          ...base,
          grading: { state: "unavailable" },
        }),
      ).label,
    ).toBe("Couldn't grade");
    expect(
      verdictBadge(
        deriveSwarmSessionVerdict({
          ...base,
          judge: { ...base.judge, automatic: false },
          grading: { state: "notRequested" },
        }),
      ).label,
    ).toBe("Not graded");
  });
});
