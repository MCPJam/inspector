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
  role: "required",
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
    expect(screen.getByText("Actual")).toBeVisible();
    expect(screen.getByText("Passed")).toHaveClass(
      "bg-success/15",
      "text-foreground",
    );
    expect(screen.getByText("Passed")).not.toHaveClass("text-success");
    expect(screen.getByText("10.2s end to end.")).toBeVisible();
    expect(screen.getByText("Why it passed")).toBeVisible();
    expect(screen.getByText("Finished within the budget.")).toBeVisible();
    expect(screen.queryByText("This gates the trial")).toBeNull();
  });
  it("labels missing evidence honestly and retains advisory semantics", () => {
    render(
      <ul>
        <TrialScorecardRow
          row={{
            ...check,
            role: "advisory",
            result: { state: "failed", source: "scoreRow" },
            evidence: undefined,
          }}
          layout="report"
        />
      </ul>,
    );
    expect(screen.getByText("Missed · advisory")).toBeVisible();
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
  it("uses a cited narrative without changing the recorded verdict or reason", () => {
    render(
      <ul>
        <TrialScorecardRow
          row={{
            ...check,
            narrative: {
              text: "The request finished within the configured time budget.",
              stale: false,
              citations: ["s:duration"],
            },
          }}
          layout="report"
        />
      </ul>,
    );
    expect(screen.getByText("Expected")).toBeVisible();
    expect(
      screen.getByText(
        "The request finished within the configured time budget.",
      ),
    ).toHaveAttribute("data-narrative-source", "ai");
    expect(screen.getByText("Passed")).toBeVisible();
    expect(screen.getByText("Finished within the budget.")).toBeVisible();
  });
  it("falls back to measured evidence when the narrative is stale", () => {
    render(
      <ul>
        <TrialScorecardRow
          row={{
            ...check,
            narrative: {
              text: "An outdated claim.",
              stale: true,
              citations: ["s:duration"],
            },
          }}
          layout="report"
        />
      </ul>,
    );
    expect(screen.queryByText("An outdated claim.")).toBeNull();
    expect(screen.getByText("10.2s end to end.")).toBeVisible();
    expect(
      screen.getByText("Narrative predates the latest grade."),
    ).toBeVisible();
  });
  it("does not leak a judge narrative during blind review", () => {
    render(
      <ul>
        <TrialScorecardRow
          row={{
            ...check,
            provenance: "judge",
            narrative: {
              text: "The judge found the outcome incomplete.",
              stale: false,
              citations: ["e:judge"],
            },
          }}
          layout="report"
          hideJudgeResult
        />
      </ul>,
    );
    expect(
      screen.queryByText("The judge found the outcome incomplete."),
    ).toBeNull();
  });

});
