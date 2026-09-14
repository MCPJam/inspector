import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrialScorecardRow } from "../case-scorecard/trial-scorecard-row";
import type { JoinedScorecardRow } from "../case-scorecard/trial-results";

const check = {
  key: "latency",
  stage: "userValue",
  provenance: "suite",
  label: "End-to-end latency ≤ 30s",
  kindLabel: "End-to-end latency",
  role: "gate",
  roleLock: "inherited",
  editable: false,
  tooltip: "This gates the trial",
  result: {
    state: "passed",
    source: "scoreRow",
    reason: "Finished within the budget.",
  },
  evidence: { scoreEvidence: ["10.2s end to end."] },
} satisfies JoinedScorecardRow;

describe("Scorecard report", () => {
  it("shows recorded observations and reasons without requiring expansion", () => {
    render(
      <ul>
        <TrialScorecardRow row={check} layout="report" />
      </ul>,
    );
    // Named once, as the heading — not repeated under a "Looks for" term.
    expect(screen.getAllByText("End-to-end latency ≤ 30s")).toHaveLength(1);
    expect(screen.getByText("Observed")).toBeVisible();
    expect(screen.getByText("10.2s end to end.")).toBeVisible();
    expect(screen.getByText("Why it passed")).toBeVisible();
    expect(screen.getByText("Finished within the budget.")).toBeVisible();
    expect(screen.queryByText("This gates the trial")).toBeNull();
  });
  it("labels missing evidence honestly and retains warning semantics", () => {
    render(
      <ul>
        <TrialScorecardRow
          row={{
            ...check,
            role: "warn",
            result: { state: "failed", source: "scoreRow" },
            evidence: undefined,
          }}
          layout="report"
        />
      </ul>,
    );
    expect(screen.getByText("Missed · warning")).toBeVisible();
    expect(screen.getByText("No observation recorded.")).toBeVisible();
    expect(screen.getByText("No reason recorded.")).toBeVisible();
  });
  it("withholds the judge's reason and evidence during blind review but retains its controls", () => {
    render(
      <ul>
        <TrialScorecardRow
          row={{ ...check, provenance: "judge" }}
          layout="report"
          hideJudgeResult
          body={<button>Label iteration</button>}
        />
      </ul>,
    );
    expect(
      screen.getByText("hidden until you label this iteration"),
    ).toBeVisible();
    expect(screen.queryByText("10.2s end to end.")).toBeNull();
    expect(screen.queryByText("Finished within the budget.")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Label iteration" }),
    ).toBeVisible();
  });
});
