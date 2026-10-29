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

  // Staging QA (Asana): a server that needs sign-in, run without a session.
  const signInBlocked: ScoreSummary = {
    score: 16,
    outcome: "failed",
    applicable: 62,
    passed: 10,
    failed: 1,
    couldNotRun: 51,
    pending: 15,
    notApplicable: 3,
  };

  it("names the sign-in instead of a verdict when checks were refused for credentials", () => {
    render(
      <OverallScoreCard
        score={signInBlocked}
        serverName="Asana"
        version="Auto"
        blockedBySignIn
      />,
    );
    expect(
      screen.getByText(
        "Incomplete. 51 checks could not run because sign-in failed. 1 check failed.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Not conformant/)).toBeNull();
  });

  it("lists every count on its own and marks a score with unrun checks partial", () => {
    render(
      <OverallScoreCard
        score={signInBlocked}
        serverName="Asana"
        version="Auto"
      />,
    );
    expect(
      screen.getByText("Not conformant. 1 check failed."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "10 passed · 1 failed · 51 could not run · 15 unscored · 3 not applicable",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("10/62 · partial")).toBeInTheDocument();
  });

  it("does not mark a complete run partial", () => {
    render(
      <OverallScoreCard
        score={passedScore(100)}
        serverName="srv"
        version="Auto"
      />,
    );
    expect(screen.getByText("10/10")).toBeInTheDocument();
    expect(screen.getByText("10 passed")).toBeInTheDocument();
  });
});
