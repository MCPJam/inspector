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
