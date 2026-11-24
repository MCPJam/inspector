import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const useQuery = vi.fn();
vi.mock("convex/react", () => ({ useQuery: (...args: unknown[]) => useQuery(...args) }));

import { RunningView } from "../running-view";

const labels = { env_a: "MCPJam · Sonnet 5.5", env_b: "Claude Code · Sonnet 5.5" };

function answer(map: Record<string, unknown>) {
  useQuery.mockImplementation((ref: { _name?: string } | unknown, args: { runId?: string }) => {
    const name = String((ref as { _name?: string })._name ?? (ref as Record<symbol, unknown>)[Symbol.for("functionName")] ?? "");
    if (args?.runId) return map[args.runId];
    return map.groups;
  });
}

describe("RunningView", () => {
  it("shows a line for each run of the unit, with how far it has got", () => {
    answer({
      groups: [
        { unitKey: "baseline:1", role: "baseline_a", runGroupId: "g1", environmentIds: ["env_a"], launchedRunIds: ["run_a1"] },
        { unitKey: "baseline:1", role: "baseline_b", runGroupId: "g2", environmentIds: ["env_a"], launchedRunIds: ["run_a2"] },
        { unitKey: "round:1", role: "candidate", runGroupId: "g3", environmentIds: ["env_a"], launchedRunIds: ["run_other"] },
      ],
      run_a1: { status: "completed", summary: { total: 30, passed: 20, failed: 10 }, configSnapshot: { environmentRef: { environmentId: "env_a" } } },
      run_a2: { status: "running", summary: { total: 30, passed: 10, failed: 4 }, configSnapshot: { environmentRef: { environmentId: "env_a" } } },
    });
    render(<RunningView title="Baseline" climbId="c1" unitKey="baseline:1" labels={labels} />);
    expect(screen.getByRole("heading", { name: "Baseline" })).toBeInTheDocument();
    const lines = screen.getAllByTestId("run-progress-line");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("MCPJam · Sonnet 5.5");
    expect(lines[0]).toHaveTextContent("Run 1 of 2 · 30 of 30 iterations");
    expect(lines[1]).toHaveTextContent("Run 2 of 2 · 14 of 30 iterations");
  });

  it("says so while the runs are starting and while progress loads", () => {
    answer({ groups: [] });
    const { unmount } = render(<RunningView title="Round 2" eyebrow="Round 2 · MCPJam" climbId="c1" unitKey="round:2" labels={labels} />);
    expect(screen.getByText("The runs are starting.")).toBeInTheDocument();
    expect(screen.getByText("Round 2 · MCPJam")).toBeInTheDocument();
    unmount();
    answer({ groups: undefined });
    render(<RunningView title="Round 2" climbId="c1" unitKey="round:2" labels={labels} />);
    expect(screen.getByText("Loading progress.")).toBeInTheDocument();
  });
});
