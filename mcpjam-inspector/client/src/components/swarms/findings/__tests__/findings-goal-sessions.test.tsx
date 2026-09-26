import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FindingsGoalSessions } from "../findings-goal-sessions";

const { mockUseGoalOutcomeDrilldown } = vi.hoisted(() => ({
  mockUseGoalOutcomeDrilldown: vi.fn(),
}));

vi.mock("@/hooks/useUsageInsights", () => ({
  useGoalOutcomeDrilldown: (...args: unknown[]) =>
    mockUseGoalOutcomeDrilldown(...args),
}));

function session(id: string, preview: string) {
  return {
    _id: id,
    firstMessagePreview: preview,
    lastActivityAt: Date.UTC(2026, 4, 1),
  };
}

beforeEach(() => {
  mockUseGoalOutcomeDrilldown.mockReset();
});

describe("FindingsGoalSessions", () => {
  it("pages the expanded goal's run the same way Insights drill-down does", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("sess-a", "Pull the proposal-stage prospects")],
        nextBefore: null,
        total: 4,
        totalTruncated: false,
      },
      isLoading: false,
    });

    render(
      <FindingsGoalSessions
        scope={{ kind: "swarm", projectId: "proj-1" }}
        goalId="run-1"
        expectedCount={4}
        onOpenSession={vi.fn()}
      />
    );

    expect(mockUseGoalOutcomeDrilldown).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          kind: "swarm",
          projectId: "proj-1",
          journeyRunIds: ["run-1"],
        },
        clusterId: null,
      })
    );
    expect(screen.getByText("Session 1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Pull the proposal-stage prospects/i,
      })
    ).toBeInTheDocument();
  });

  it("pages a User Testing goal by its cluster, carrying the surface filter", () => {
    // A swarm goal is a run; a scenario goal is a goal-axis cluster. Paging a
    // scenario by journeyRunIds would ask the wrong query, and dropping the
    // filter would list sessions the count above it excluded.
    const filters = { preset: "all" as const, chips: [] };
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [session("sess-a", "draw a cat")],
        nextBefore: null,
        total: 1,
        totalTruncated: false,
      },
      isLoading: false,
    });

    render(
      <FindingsGoalSessions
        scope={{ kind: "scenario", scenarioId: "cb-1", filters }}
        goalId="cluster-9"
        expectedCount={1}
        onOpenSession={vi.fn()}
      />
    );

    expect(mockUseGoalOutcomeDrilldown).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "scenario", scenarioId: "cb-1" },
        clusterId: "cluster-9",
        filters,
      })
    );
    expect(screen.getByText("Session 1")).toBeInTheDocument();
  });

  it("opens the clicked session", async () => {
    const onOpenSession = vi.fn();
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [
          session("sess-a", "First prompt"),
          session("sess-b", "Second prompt"),
        ],
        nextBefore: null,
        total: 2,
        totalTruncated: false,
      },
      isLoading: false,
    });

    render(
      <FindingsGoalSessions
        scope={{ kind: "swarm", projectId: "proj-1" }}
        goalId="run-1"
        expectedCount={2}
        onOpenSession={onOpenSession}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: /Second prompt/i })
    );
    expect(onOpenSession).toHaveBeenCalledWith("sess-b");
  });
});

/**
 * #5188: a session refused before it recorded a message listed as
 * "Session 1 (no preview)", which read as a session that ran and said
 * nothing.
 *
 * Rows here have the drilldown's REAL shape: no `sourceType`, because the
 * backend normalizes `swarm` away on every list row. A fixture that set it
 * hid exactly that, and the tag never showed against the real backend.
 */
describe("FindingsGoalSessions for sessions that never ran", () => {
  const swarmProps = {
    scope: { kind: "swarm" as const, projectId: "proj-1" },
    goalId: "run-1",
    onOpenSession: vi.fn(),
  };
  const page = (sessions: unknown[]) => ({
    drilldown: {
      sessions,
      nextBefore: null,
      total: sessions.length,
      totalTruncated: false,
    },
    isLoading: false,
  });

  it("says the session didn't run instead of showing an empty preview", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue(
      page([
        {
          ...session("sess-refused", ""),
          messageCount: 0,
          runAttemptStatus: "failed",
        },
        {
          ...session("sess-ran", "Pull the proposal-stage prospects"),
          messageCount: 6,
          runAttemptStatus: "failed",
        },
      ])
    );

    render(<FindingsGoalSessions {...swarmProps} expectedCount={2} />);

    expect(
      screen.getAllByTestId("findings-goal-session-never-ran")
    ).toHaveLength(1);
    expect(screen.getByText("Didn't run")).toBeInTheDocument();
    expect(screen.queryByText("(no preview)")).not.toBeInTheDocument();
    // The one that ran and then failed still shows what it said.
    expect(
      screen.getByText('"Pull the proposal-stage prospects"')
    ).toBeInTheDocument();
  });

  it("keeps the old row when a backend sends no attempt status", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue(
      page([{ ...session("sess-a", ""), messageCount: 0 }])
    );

    render(<FindingsGoalSessions {...swarmProps} expectedCount={1} />);

    expect(screen.getByText("(no preview)")).toBeInTheDocument();
    expect(
      screen.queryByTestId("findings-goal-session-never-ran")
    ).not.toBeInTheDocument();
  });

  it("never marks a User Testing session, whatever its row carries", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue(
      page([
        {
          ...session("sess-a", ""),
          messageCount: 0,
          runAttemptStatus: "failed",
        },
      ])
    );

    render(
      <FindingsGoalSessions
        scope={{ kind: "scenario", scenarioId: "scn-1" }}
        goalId="cluster-1"
        expectedCount={1}
        onOpenSession={vi.fn()}
      />
    );

    expect(
      screen.queryByTestId("findings-goal-session-never-ran")
    ).not.toBeInTheDocument();
  });

  it("marks a session whose attempt settles while the goal is open", () => {
    // The live transition: the attempt is still running with nothing
    // recorded, then it fails before the conversation starts. The page cache
    // bails out on an equal page, so equal has to include the attempt.
    const refused = (runAttemptStatus: "running" | "failed") =>
      page([{ ...session("sess-a", ""), messageCount: 0, runAttemptStatus }]);

    mockUseGoalOutcomeDrilldown.mockReturnValue(refused("running"));
    const { rerender } = render(
      <FindingsGoalSessions {...swarmProps} expectedCount={1} />
    );
    expect(screen.getByText("(no preview)")).toBeInTheDocument();

    mockUseGoalOutcomeDrilldown.mockReturnValue(refused("failed"));
    rerender(<FindingsGoalSessions {...swarmProps} expectedCount={1} />);
    expect(
      screen.getByTestId("findings-goal-session-never-ran")
    ).toHaveTextContent("Didn't run");
  });
});
