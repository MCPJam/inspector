import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  describeLaunchFailures,
  NeverRanTag,
  SwarmSessionNotRun,
  threadNeverRan,
} from "../swarm-session-not-run";
import type { RunLaunchFailures } from "@/lib/swarm-api";

/**
 * #5188: a swarm session whose attempt ended without recording a message
 * never ran. These pin the one rule every surface reads, and what each says.
 */

const swarm = { sourceType: "swarm" as const, messageCount: 0 };
const IDENTITY_400 = "Persona turn failed: 400 invalid identity";

describe("threadNeverRan", () => {
  it("reads a list row's resolved flag first", () => {
    expect(threadNeverRan({ ...swarm, neverRan: true })).toBe(true);
    expect(
      threadNeverRan({ ...swarm, neverRan: false, runAttemptStatus: "failed" }),
    ).toBe(false);
  });

  it("derives it from an ended attempt that recorded nothing", () => {
    expect(threadNeverRan({ ...swarm, runAttemptStatus: "failed" })).toBe(true);
    expect(threadNeverRan({ ...swarm, runAttemptStatus: "rate_limited" })).toBe(
      true,
    );
  });

  it("is false for a session that ran and then failed", () => {
    expect(
      threadNeverRan({ ...swarm, messageCount: 4, runAttemptStatus: "failed" }),
    ).toBe(false);
  });

  it("never claims it without an attempt that ended unsuccessfully", () => {
    for (const status of [
      undefined,
      null,
      "pending",
      "running",
      "succeeded",
    ] as const)
      expect(threadNeverRan({ ...swarm, runAttemptStatus: status })).toBe(
        false,
      );
  });

  it("is false outside swarm sessions", () => {
    expect(
      threadNeverRan({
        sourceType: "scenario",
        messageCount: 0,
        runAttemptStatus: "failed",
      }),
    ).toBe(false);
  });
});

describe("SwarmSessionNotRun", () => {
  it("says the session never ran and shows the recorded reason", () => {
    render(
      <SwarmSessionNotRun
        status="failed"
        errorCode="session_failed"
        errorMessage={IDENTITY_400}
      />,
    );
    expect(screen.getByTestId("swarm-session-not-run")).toHaveTextContent(
      "This session didn't run",
    );
    expect(screen.getByTestId("swarm-session-not-run")).toHaveTextContent(
      "nothing about the server was tested",
    );
    expect(
      screen.getByTestId("swarm-session-not-run-reason"),
    ).toHaveTextContent(/invalid identity/i);
  });

  it("falls back to the attempt status when no reason was recorded", () => {
    const { rerender } = render(<SwarmSessionNotRun status="rate_limited" />);
    expect(
      screen.getByTestId("swarm-session-not-run-reason"),
    ).toHaveTextContent(
      "A rate limit stopped its attempt before the conversation started.",
    );

    // An unknown code alone humanizes to "failed for an unknown reason",
    // which says less than the status does.
    // Exact, not a substring: the generic default also ends in "No reason was
    // recorded.", so a looser match would pass with the failed sentence gone.
    rerender(<SwarmSessionNotRun status="failed" errorCode="mystery_code" />);
    expect(screen.getByTestId("swarm-session-not-run-reason").textContent).toBe(
      "Its attempt failed before the conversation started. No reason was recorded.",
    );
  });
});

describe("describeLaunchFailures", () => {
  const run = (
    runId: string,
    sessionsNotRun: number,
    reasons: RunLaunchFailures["reasons"],
  ): RunLaunchFailures => ({
    runId,
    sessionsNotRun,
    sessionsTotal: sessionsNotRun,
    reasons,
  });

  it("is null when no session was refused", () => {
    expect(describeLaunchFailures(undefined)).toBeNull();
    expect(describeLaunchFailures([])).toBeNull();
  });

  it("names the refusal once when it covers every session", () => {
    const reason = describeLaunchFailures([
      run("a", 2, [
        { errorCode: "session_failed", errorMessage: IDENTITY_400, count: 2 },
      ]),
      run("b", 1, [
        { errorCode: "session_failed", errorMessage: IDENTITY_400, count: 1 },
      ]),
    ]);
    expect(reason).toMatch(/invalid identity/i);
    expect(reason).not.toMatch(/sessions that didn't run/);
  });

  it("says how many it covers when reasons differ", () => {
    const reason = describeLaunchFailures([
      run("a", 3, [
        { errorCode: "session_failed", errorMessage: IDENTITY_400, count: 2 },
        {
          errorCode: "rate_limited",
          errorMessage: "429 Too Many Requests",
          count: 1,
        },
      ]),
    ]);
    expect(reason).toMatch(/invalid identity/i);
    expect(reason).toMatch(/\(2 of the 3 sessions that didn't run\)$/);
  });

  it("is null when no attempt recorded a usable reason", () => {
    expect(
      describeLaunchFailures([
        run("a", 2, [{ errorCode: null, errorMessage: null, count: 2 }]),
      ]),
    ).toBeNull();
  });
});

describe("NeverRanTag", () => {
  it("reads as a state, not as a missing preview", () => {
    render(<NeverRanTag />);
    expect(screen.getByTestId("swarm-session-never-ran-tag")).toHaveTextContent(
      "Didn't run",
    );
  });
});
