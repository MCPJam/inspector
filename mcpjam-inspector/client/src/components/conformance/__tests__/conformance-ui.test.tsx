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
  it("keeps a score of 100 visibly incomplete when some checks need input", () => {
    render(
      <OverallScoreCard
        score={{ ...passedScore(100), outcome: "incomplete", couldNotRun: 2 }}
        serverName="srv"
        version="2025-11-25"
      />,
    );
    expect(
      screen.getByText(
        "Incomplete. 2 checks need input. Select tools in setup and run again.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("10 passed · 2 not run (missing input)"),
    ).toBeInTheDocument();
    expect(screen.getByText("10/10 · partial")).toBeInTheDocument();
    expect(screen.queryByText("Fully conformant.")).toBeNull();
  });

  it("reads a passed run with advice as advised even without its advisories", () => {
    // A saved run's summary carries an advice count, not an advisories list.
    render(
      <OverallScoreCard
        score={{ ...passedScore(100), advisoryCount: 1 }}
        serverName="srv"
        version="Auto"
      />,
    );
    expect(screen.getByText("Conformant, with guidance.")).toBeInTheDocument();
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
        blockedBySignIn={66}
      />,
    );
    expect(
      screen.getByText(
        "Incomplete. 51 checks could not run because sign-in failed. 1 check failed. Reconnect the server and run again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Not conformant/)).toBeNull();
  });

  it("counts only the checks sign-in blocked, and the rest on their own", () => {
    render(
      <OverallScoreCard
        score={{
          ...signInBlocked,
          couldNotRun: 2,
          failed: 0,
          outcome: "incomplete",
        }}
        serverName="Asana"
        version="Auto"
        blockedBySignIn={1}
      />,
    );
    expect(
      screen.getByText(
        "Incomplete. 1 check could not run because sign-in failed. 1 more could not run. Reconnect the server and run again.",
      ),
    ).toBeInTheDocument();
  });

  it("names the timeout when checks could not run because the server was slow", () => {
    render(
      <OverallScoreCard
        score={{
          ...signInBlocked,
          couldNotRun: 3,
          failed: 0,
          outcome: "incomplete",
        }}
        serverName="Slow"
        version="Auto"
        timedOut={2}
      />,
    );
    expect(
      screen.getByText(
        "Incomplete. 2 checks could not run because the server did not answer in time. 1 more could not run.",
      ),
    ).toBeInTheDocument();
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
