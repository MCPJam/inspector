import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OverallScoreCard, type ScoreSummary } from "../conformance-ui";

function passedScore(score: number): ScoreSummary {
  return {
    score,
    outcome: "passed",
    applicable: 10,
    passed: 10,
    failed: 0,
    couldNotRun: 0,
  };
}

describe("OverallScoreCard", () => {
  it("reads a passed run under 100 as advised even without its advisories", () => {
    // A saved run's summary carries no advisories list.
    render(
      <OverallScoreCard
        score={passedScore(97)}
        serverName="srv"
        version="Auto"
      />,
    );
    expect(screen.getByText("Conformant, with advice.")).toBeInTheDocument();
  });

  it("reads a passed run at 100 as fully conformant", () => {
    render(
      <OverallScoreCard
        score={passedScore(100)}
        serverName="srv"
        version="Auto"
      />,
    );
    expect(screen.getByText("Fully conformant.")).toBeInTheDocument();
  });

  it("gives no verdict on a partial score while suites are still running", () => {
    render(
      <OverallScoreCard
        score={passedScore(100)}
        serverName="srv"
        version="Auto"
        isRunning
      />,
    );
    expect(screen.queryByText("Fully conformant.")).toBeNull();
    expect(
      screen.getByText("Running conformance checks..."),
    ).toBeInTheDocument();
  });

  it("reads a run that ended without a score as incomplete, not empty", () => {
    // A timed-out run is saved with outcome "incomplete" and no score.
    render(
      <OverallScoreCard
        score={{
          score: null,
          outcome: "incomplete",
          applicable: 0,
          passed: 0,
          failed: 0,
          couldNotRun: 0,
        }}
        serverName="srv"
        version="Auto"
      />,
    );
    expect(
      screen.getByText("Incomplete. No check finished, so there is no score."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Nothing applicable to score on this server."),
    ).toBeNull();
  });
});
