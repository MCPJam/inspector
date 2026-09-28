import {
  sessionChipTone,
  sessionGoalResultAttr,
  slotView,
} from "../new-swarm-running-step";
import type { JourneySessionRow } from "@/lib/swarm-api";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  assembleSwarmReport,
  deriveSwarmSessionVerdict,
} from "@mcpjam/sdk/contract";
import { SwarmReportPanel, SwarmSessionReport } from "../swarm-report-panel";
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
  it("stays quiet when a run has no decision yet", () => {
    const { container } = render(<SwarmReportPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a passed goal independently from interrupted execution", () => {
    const v = verdict(true);
    expect(lifecycleChip(v.lifecycle).label).toBe("Broke");
    expect(verdictBadge(v).label).toBe("Passed");
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
    ).toBe("Inconclusive");
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

it("keeps completed ungraded and broken passed create-flow cells distinct", () => {
  for (const v of [
    verdict(true),
    {
      ...verdict(true),
      lifecycle: "ran" as const,
      verdict: "inconclusive" as const,
    },
    {
      ...verdict(true),
      lifecycle: "ran" as const,
      verdict: "notEstablished" as const,
    },
  ]) {
    const view = slotView({
      session: {
        verdict: v,
        messageCount: 2,
        outcome: "succeeded",
      } as JourneySessionRow,
      runStatus: "completed",
      goal: "Find it",
    });
    expect(view.outcome).toBe(v.lifecycle === "broke" ? "failed" : "succeeded");
    expect(view.verdict).toBe(v);
    expect(view.headline).toMatch(
      v.lifecycle === "broke" ? /^Broke:/ : /^Run completed:/,
    );
  }
  expect(verdictBadge().label).toBe("Unknown");
});

it("does not print goal result or the value chain on the session report", () => {
  render(
    <SwarmSessionReport
      session={{ verdict: verdict(true) } as JourneySessionRow}
    />,
  );
  expect(screen.queryByText(/Goal result/)).not.toBeInTheDocument();
  expect(screen.queryByText(/User value chain/)).not.toBeInTheDocument();
  expect(screen.getByText("Execution: Broke")).toBeInTheDocument();
});

it("colors a session chip by goal result, not execution", () => {
  const passedBroke = verdict(true);
  expect(
    sessionChipTone({ outcome: "failed", verdict: passedBroke }),
  ).toContain("border-success");
  expect(
    sessionChipTone({
      outcome: "succeeded",
      verdict: { ...verdict(false), lifecycle: "ran", verdict: "failed" },
    }),
  ).toContain("border-destructive");
  expect(sessionChipTone({ outcome: "running" })).toContain("border-primary");
  expect(sessionGoalResultAttr(passedBroke)).toBe("passed");
  expect(sessionGoalResultAttr()).toBe("unknown");
});
