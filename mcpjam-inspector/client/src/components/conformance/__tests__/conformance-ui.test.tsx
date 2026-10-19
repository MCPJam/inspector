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
});
