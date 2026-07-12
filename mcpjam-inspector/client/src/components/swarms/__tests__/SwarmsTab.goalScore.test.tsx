import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Guards the swarm judge presentation helpers: the wide-shape guard, the
 * per-session badge states (completed / running / failed / absent), and the
 * rollup average label. Heavy SwarmsTab deps are stubbed — these helpers are
 * pure of Convex state.
 */
vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
}));
vi.mock(
  "@/components/connection/share-usage/ShareUsageThreadDetail",
  () => ({ ShareUsageThreadDetail: () => null }),
);
vi.mock("@/components/swarms/SwarmHostsPanel", () => ({
  SwarmHostsPanel: () => null,
}));

import {
  goalScoreAvgLabel,
  SessionGoalScoreBadge,
  toSessionGoalScore,
} from "../SwarmsTab";

describe("toSessionGoalScore (wide-shape guard)", () => {
  it("rejects absent, unknown-status, and completed-without-finite-score records", () => {
    expect(toSessionGoalScore(undefined)).toBeUndefined();
    expect(toSessionGoalScore({ status: "bogus" })).toBeUndefined();
    expect(toSessionGoalScore({ status: "completed" })).toBeUndefined();
    expect(
      toSessionGoalScore({ status: "completed", score: Number.NaN }),
    ).toBeUndefined();
  });

  it("accepts the three valid statuses", () => {
    expect(toSessionGoalScore({ status: "running" })?.status).toBe("running");
    expect(toSessionGoalScore({ status: "failed", error: "x" })?.status).toBe(
      "failed",
    );
    expect(
      toSessionGoalScore({ status: "completed", score: 0.8, passed: true })
        ?.score,
    ).toBe(0.8);
  });
});

describe("SessionGoalScoreBadge", () => {
  it("renders score + verdict for a completed record", () => {
    render(
      <SessionGoalScoreBadge
        goalScore={{ status: "completed", score: 0.82, passed: true }}
      />,
    );
    expect(screen.getByText(/82%/)).toBeInTheDocument();
    expect(screen.getByText(/meets goal/)).toBeInTheDocument();
  });

  it("renders 'below threshold' for a completed failing record", () => {
    render(
      <SessionGoalScoreBadge
        goalScore={{ status: "completed", score: 0.4, passed: false }}
      />,
    );
    expect(screen.getByText(/below threshold/)).toBeInTheDocument();
  });

  it("renders judging… while running and 'judge unavailable' on failure (never hidden)", () => {
    const { rerender } = render(
      <SessionGoalScoreBadge goalScore={{ status: "running" }} />,
    );
    expect(screen.getByText(/judging…/)).toBeInTheDocument();
    rerender(
      <SessionGoalScoreBadge
        goalScore={{ status: "failed", error: "spend_cap_exceeded" }}
      />,
    );
    expect(screen.getByText(/judge unavailable/)).toBeInTheDocument();
  });

  it("renders nothing for absent or malformed records", () => {
    const { container } = render(<SessionGoalScoreBadge goalScore={undefined} />);
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = render(
      <SessionGoalScoreBadge goalScore={{ status: "??" }} />,
    );
    expect(c2).toBeEmptyDOMElement();
  });
});

describe("goalScoreAvgLabel", () => {
  it("returns null until something was graded", () => {
    expect(goalScoreAvgLabel(undefined)).toBeNull();
    expect(
      goalScoreAvgLabel({ gradedCount: 0, passedCount: 0, avgScore: null }),
    ).toBeNull();
  });

  it("formats the average + graded count", () => {
    expect(
      goalScoreAvgLabel({ gradedCount: 4, passedCount: 3, avgScore: 0.78 }),
    ).toBe("goal 78% avg (4 judged)");
  });
});
