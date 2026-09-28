import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrialScorecardRow } from "../case-scorecard/trial-scorecard-row";
import { RUBRIC_SOURCE_HINT } from "../case-scorecard/case-scorecard-model";
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
    // Two lines, not three: the reason leads ACTUAL and the evidence follows
    // it, in one cell. No "Why it passed" line repeating the reason.
    const actual = screen.getByTestId("trial-scorecard-reason");
    expect(actual).toHaveTextContent("Finished within the budget.");
    expect(actual).toHaveTextContent("10.2s end to end.");
    expect(screen.queryByText("Why it passed")).toBeNull();
    expect(screen.queryByText("Reason")).toBeNull();
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
    expect(screen.queryByText("No reason recorded.")).toBeNull();
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
  it("uses a cited narrative as ACTUAL without changing the recorded verdict", () => {
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
    // The narrative IS the actual; the recorded reason is not printed again
    // under it.
    expect(screen.queryByText("Finished within the budget.")).toBeNull();
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
    expect(screen.getByTestId("trial-scorecard-reason")).toHaveTextContent(
      "10.2s end to end.",
    );
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

  it("gives the judge row the case's expected outcome as its expectation", () => {
    // The sentence the judge was asked to decide, verbatim. A reader comparing
    // EXPECTED with ACTUAL is comparing the case's own words with what ran.
    const goal =
      "Server diagnostics reveal connection status and the run completes.";
    render(
      <ul>
        <TrialScorecardRow
          row={{
            ...check,
            key: "judge:goalCompletion",
            label: "Outcome achieved",
            provenance: "judge",
            judge: {
              suiteMode: "expected_output",
              model: "gpt-5",
              threshold: 0.7,
              suiteCriteriaCount: 0,
              skippedForCase: false,
              runsForCase: true,
              rubricSource: "expected_output",
              goal,
            },
          }}
          layout="report"
        />
      </ul>,
    );
    expect(screen.getByText(goal)).toBeVisible();
    expect(
      screen.queryByText(
        "Satisfy the task according to the configured judge rubric.",
      ),
    ).toBeNull();
  });

  it("names what the judge graded against when the case has no goal", () => {
    render(
      <ul>
        <TrialScorecardRow
          row={{
            ...check,
            key: "judge:goalCompletion",
            label: "Outcome achieved",
            provenance: "judge",
            judge: {
              suiteMode: "automatic",
              model: "gpt-5",
              threshold: 0.7,
              suiteCriteriaCount: 2,
              skippedForCase: false,
              runsForCase: true,
              rubricSource: "suite_criteria",
              goal: "",
            },
          }}
          layout="report"
        />
      </ul>,
    );
    expect(
      screen.getByText(RUBRIC_SOURCE_HINT.suite_criteria),
    ).toBeVisible();
  });
});
