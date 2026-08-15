/**
 * The per-session Checks panel.
 *
 * What these pin:
 *   - The evaluator's `reason` strings reach a screen. They have been
 *     persisted since the rubric path shipped and rendered nowhere; a panel
 *     that shows PASS/FAIL without the reason would leave that unchanged.
 *   - Judge rows never render here, INCLUDING the running and failed ones
 *     that carry no `goalCompletionResult` to sniff. Those are the rows a
 *     presence-based rule turns into empty duplicate groups.
 *   - A grading FAILURE is never hidden by age behind the history disclosure.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionChecksSection } from "../SessionChecksSection";
import type { SessionCheckRun } from "../session-check-runs";

const { mockUseQuery } = vi.hoisted(() => ({ mockUseQuery: vi.fn() }));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

const RUBRIC = {
  setKind: "journey_rubric",
  predicates: [],
  criteria: [
    {
      id: "crit-refund",
      label: "Finds the refund",
      predicate: { type: "toolCalledAtLeastOnce" as const, toolName: "refund" },
    },
    {
      id: "crit-clean",
      predicate: { type: "noToolErrors" as const },
    },
  ],
};

function swarmChecksRow(over: Partial<SessionCheckRun> = {}): SessionCheckRun {
  return {
    _id: "chk-1",
    checkRunId: "swarmchecks:session-1",
    source: "swarm",
    runKind: "checks",
    status: "completed",
    createdAt: 2000,
    definitionSnapshot: RUBRIC,
    criterionResults: [
      { criterionId: "crit-refund", passed: true, reason: 'called "refund" 1x' },
      {
        criterionId: "crit-clean",
        passed: false,
        reason: "1 of 3 tool calls reported an error",
      },
    ],
    ...over,
  };
}

describe("SessionChecksSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders each check with its name, verdict and the evaluator's reason", () => {
    mockUseQuery.mockReturnValue([swarmChecksRow()]);
    render(<SessionChecksSection chatSessionId="session-1" />);

    expect(screen.getByTestId("session-checks-section")).toBeInTheDocument();
    // Author label wins; the unlabeled row is named by its predicate kind.
    expect(screen.getByText("Finds the refund")).toBeInTheDocument();
    expect(screen.getByText("No tool errors")).toBeInTheDocument();
    // The load-bearing part: WHY, not just whether.
    expect(screen.getByText('called "refund" 1x')).toBeInTheDocument();
    expect(
      screen.getByText("1 of 3 tool calls reported an error")
    ).toBeInTheDocument();
    // Origin, and the pass tally kept separate from the run's status.
    expect(screen.getByText("Swarm")).toBeInTheDocument();
    expect(screen.getByText("1 / 2 passed")).toBeInTheDocument();
  });

  it("keys the subscription on the chatSessions doc id it was given", () => {
    mockUseQuery.mockReturnValue([swarmChecksRow()]);
    render(<SessionChecksSection chatSessionId="session-1" />);

    expect(mockUseQuery).toHaveBeenCalledWith(
      "chatSessionChecks:getCheckRunsForSession",
      { chatSessionId: "session-1" }
    );
  });

  it("skips the query when the session id is not known yet", () => {
    mockUseQuery.mockReturnValue(undefined);
    render(<SessionChecksSection chatSessionId={undefined} />);

    expect(mockUseQuery).toHaveBeenCalledWith(
      "chatSessionChecks:getCheckRunsForSession",
      "skip"
    );
    expect(screen.queryByTestId("session-checks-section")).toBeNull();
  });

  it("renders nothing when the session has no check rows", () => {
    mockUseQuery.mockReturnValue([]);
    render(<SessionChecksSection chatSessionId="session-1" />);
    expect(screen.queryByTestId("session-checks-section")).toBeNull();
  });

  it("renders nothing while the query is still loading", () => {
    mockUseQuery.mockReturnValue(undefined);
    render(<SessionChecksSection chatSessionId="session-1" />);
    expect(screen.queryByTestId("session-checks-section")).toBeNull();
  });

  it("excludes judge rows, including running and failed ones", () => {
    mockUseQuery.mockReturnValue([
      swarmChecksRow(),
      // Completed judge: has a verdict, but it belongs to SwarmJudgeSection.
      {
        _id: "judge-1",
        checkRunId: "swarm_judge:session-1:gen-1",
        source: "scheduled",
        runKind: "judge",
        status: "completed",
        createdAt: 3000,
        definitionSnapshot: { setKind: "ad_hoc", predicates: [] },
        goalCompletionResult: { score: 0.9, passed: true },
      },
      // Running judge — no result to sniff.
      {
        _id: "judge-2",
        checkRunId: "swarm_judge:session-1:gen-2",
        source: "on_demand",
        runKind: "judge",
        status: "running",
        createdAt: 4000,
        definitionSnapshot: { setKind: "ad_hoc", predicates: [] },
      },
      // Failed judge — likewise no result, and an error string that must NOT
      // surface as a checks-grading failure.
      {
        _id: "judge-3",
        checkRunId: "session-1_on_demand_judge_1717171717",
        source: "on_demand",
        runKind: "judge",
        status: "failed",
        error: "missing_api_key",
        createdAt: 5000,
        definitionSnapshot: { setKind: "ad_hoc", predicates: [] },
      },
    ] as SessionCheckRun[]);

    render(<SessionChecksSection chatSessionId="session-1" />);

    // Exactly one group: the checks run.
    expect(screen.getAllByText("Checks")).toHaveLength(1);
    expect(screen.getByText("Finds the refund")).toBeInTheDocument();
    expect(screen.queryByText(/missing_api_key/)).toBeNull();
    expect(screen.queryByText("Scheduled")).toBeNull();
  });

  it("leads with the newest run and collapses older ones behind a disclosure", async () => {
    const user = userEvent.setup();
    mockUseQuery.mockReturnValue([
      // Deliberately oldest-first, the order the backend query returns.
      swarmChecksRow({
        _id: "chk-old",
        checkRunId: "session-1_on_demand_0",
        source: "on_demand",
        createdAt: 1000,
        criterionResults: [
          {
            criterionId: "crit-refund",
            passed: false,
            reason: "stale verdict from the first grade",
          },
        ],
      }),
      swarmChecksRow({ _id: "chk-new", createdAt: 2000 }),
    ]);

    render(<SessionChecksSection chatSessionId="session-1" />);

    // The current verdict renders outside any disclosure…
    const currentReason = screen.getByText('called "refund" 1x');
    const disclosure = screen
      .getByText("Previous runs (1)")
      .closest("details") as HTMLDetailsElement;
    expect(disclosure.contains(currentReason)).toBe(false);

    // …and the superseded one is inside it, collapsed. Asserted via `open`
    // and containment rather than queryability: jsdom does not hide the
    // contents of a closed `<details>`, so a queryByText(...).toBeNull()
    // here would be testing nothing.
    const staleReason = screen.getByText("stale verdict from the first grade");
    expect(disclosure.contains(staleReason)).toBe(true);
    expect(disclosure.open).toBe(false);

    await user.click(screen.getByText("Previous runs (1)"));
    expect(disclosure.open).toBe(true);
    expect(screen.getByText("On demand")).toBeInTheDocument();
  });

  it("surfaces an older run's grading failure without opening the disclosure", () => {
    mockUseQuery.mockReturnValue([
      swarmChecksRow({
        _id: "chk-broken",
        checkRunId: "session-1_on_demand_0",
        source: "on_demand",
        status: "failed",
        error: "transcript load failed: storage blob missing",
        createdAt: 1000,
        criterionResults: undefined,
      }),
      swarmChecksRow({ _id: "chk-new", createdAt: 2000 }),
    ]);

    render(<SessionChecksSection chatSessionId="session-1" />);

    // An infrastructure failure is never hidden by age — and it reads as
    // "not graded", never as a failing check.
    expect(
      screen.getByText(/transcript load failed: storage blob missing/)
    ).toBeInTheDocument();
    expect(screen.getByText("Not graded")).toBeInTheDocument();
    // It is pulled OUT of the history disclosure rather than duplicated in it.
    expect(screen.queryByText(/Previous runs/)).toBeNull();
  });

  it("shows a running run as running, with no verdicts invented", () => {
    mockUseQuery.mockReturnValue([
      swarmChecksRow({
        status: "running",
        criterionResults: undefined,
      }),
    ]);

    render(<SessionChecksSection chatSessionId="session-1" />);
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.queryByText("PASS")).toBeNull();
    expect(screen.queryByText("FAIL")).toBeNull();
  });
});
