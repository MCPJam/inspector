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
  it("counts checks a login stopped once, in the sign-in sentence", () => {
    render(
      <OverallScoreCard
        score={{
          ...passedScore(100),
          score: null,
          applicable: 0,
          passed: 0,
          outcome: "incomplete",
          couldNotRun: 3,
        }}
        serverName="srv"
        version="2025-11-25"
        blockedBySignIn={3}
      />,
    );
    expect(
      screen.getByText(
        "Incomplete. 3 checks could not run because sign-in failed. Reconnect the server and run again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/needs setup\)/)).toBeNull();
    expect(screen.queryByText(/setup change/)).toBeNull();
  });

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
        "Incomplete. 2 checks need a setup change. Each one says what to change, then run again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/needs setup\)/)).toBeNull();
    expect(screen.queryByText(/passed/)).toBeNull();
    expect(screen.getByText("10/10")).toBeInTheDocument();
    expect(screen.queryByText(/partial/)).toBeNull();
    expect(screen.queryByText("Conformant.")).toBeNull();
  });

  it("calls a passed run that skipped optional input checks conformant", () => {
    render(
      <OverallScoreCard
        score={{ ...passedScore(100), couldNotRun: 2 }}
        serverName="srv"
        version="2025-11-25"
      />,
    );
    expect(
      screen.getByText(
        "Conformant. 2 checks need a setup change. Each one says what to change, then run again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/needs setup\)/)).toBeNull();
    expect(screen.getByText("10/10")).toBeInTheDocument();
    expect(screen.queryByText(/partial/)).toBeNull();
  });

  it("keeps guidance ahead of the input hint when a passed run has both", () => {
    render(
      <OverallScoreCard
        score={{ ...passedScore(100), couldNotRun: 2, advisoryCount: 1 }}
        serverName="srv"
        version="2025-11-25"
      />,
    );
    expect(
      screen.getByText(
        "Conformant, with guidance. 2 checks need a setup change. Each one says what to change, then run again.",
      ),
    ).toBeInTheDocument();
  });

  it.each([
    [
      3,
      0,
      "Incomplete. 3 checks could not run. 2 checks need a setup change. Each one says what to change, then run again.",
    ],
    [
      3,
      3,
      "Incomplete. 3 checks could not run because the server did not answer in time. 2 checks need a setup change. Each one says what to change, then run again.",
    ],
    [
      3,
      2,
      "Incomplete. 2 checks could not run because the server did not answer in time. 1 more could not run. 2 checks need a setup change. Each one says what to change, then run again.",
    ],
  ])(
    "keeps other unrun causes alongside missing inputs (%i unrun, %i timed out)",
    (otherUnrun, timedOut, expected) => {
      render(
        <OverallScoreCard
          score={{
            ...passedScore(76.9),
            outcome: "incomplete",
            applicable: 10 + otherUnrun,
            couldNotRun: 2 + otherUnrun,
          }}
          serverName="srv"
          version="Auto"
          timedOut={timedOut}
        />,
      );
      expect(screen.getByText(expected)).toBeInTheDocument();
    },
  );

  it("names missing inputs when no selected check ran", () => {
    render(
      <OverallScoreCard
        score={{
          ...passedScore(100),
          score: null,
          passed: 0,
          applicable: 0,
          couldNotRun: 7,
          outcome: "incomplete",
        }}
        serverName="srv"
        version="Auto"
      />,
    );
    expect(
      screen.getByText(
        "Incomplete. 7 checks need a setup change. Each one says what to change, then run again.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Nothing applicable to score on this server."),
    ).toBeNull();
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

  it("reads a passed run at 100 as conformant", () => {
    render(
      <OverallScoreCard
        score={passedScore(100)}
        serverName="srv"
        version="Auto"
      />,
    );
    expect(screen.getByText("Conformant.")).toBeInTheDocument();
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
    expect(screen.queryByText("Conformant.")).toBeNull();
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
        "Incomplete. 51 checks could not run because sign-in failed. Reconnect the server and run again.",
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

  it("lists every count on its own", () => {
    render(
      <OverallScoreCard
        score={signInBlocked}
        serverName="Asana"
        version="Auto"
      />,
    );
    expect(screen.getByText("Not conformant.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "51 checks could not run, 15 checks unscored, and 3 checks not applicable.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("10/62")).toBeInTheDocument();
    expect(screen.queryByText(/partial/)).toBeNull();
  });

  it("joins leftover checks as a sentence after the verdict", () => {
    render(
      <OverallScoreCard
        score={{
          score: 76.4,
          outcome: "failed",
          applicable: 51,
          passed: 39,
          failed: 1,
          couldNotRun: 11,
          notApplicable: 15,
        }}
        serverName="srv"
        version="Auto"
      />,
    );
    expect(screen.getByText("Not conformant.")).toBeInTheDocument();
    expect(
      screen.getByText("11 checks could not run and 15 checks not applicable."),
    ).toBeInTheDocument();
  });

  it("leaves the could-not-run count to the verdict when it already says it", () => {
    render(
      <OverallScoreCard
        score={{
          score: 85.7,
          outcome: "incomplete",
          applicable: 28,
          passed: 24,
          failed: 0,
          couldNotRun: 4,
          notApplicable: 38,
        }}
        serverName="amazon-test"
        version="2025-11-25"
      />,
    );
    expect(
      screen.getByText("Incomplete. 4 checks could not run."),
    ).toBeInTheDocument();
    expect(screen.getByText("38 checks not applicable.")).toBeInTheDocument();
  });

  it("shows the fraction without a partial mark", () => {
    render(
      <OverallScoreCard
        score={passedScore(100)}
        serverName="srv"
        version="Auto"
      />,
    );
    expect(screen.getByText("10/10")).toBeInTheDocument();
    expect(screen.queryByText("10 passed")).toBeNull();
  });
});
