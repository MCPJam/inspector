import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { deriveSwarmSessionVerdict } from "@mcpjam/sdk/contract";
import type { SwarmSessionVerdict } from "@mcpjam/sdk/contract";
import { SwarmHostCell } from "../journey-run-results";

vi.mock("convex/react", () => ({
  useQuery: () => null,
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

function cell(verdict: SwarmSessionVerdict) {
  render(
    <SwarmHostCell
      hostLabel="Claude"
      sessionIndex={0}
      outcome="succeeded"
      verdict={verdict}
      selected={false}
      onSelect={() => {}}
    />,
  );
}

/** A goal with no rubric: the judge decides alone, so `counts.gating` is 0. */
const unrubricked = {
  hasTranscript: true,
  rubric: [],
  criteria: null,
  judge: { automatic: true, role: "required" },
  grading: { state: "settled" },
} as const;

describe("SwarmHostCell evaluator count", () => {
  it("claims no denominator when the run pinned no rubric", () => {
    const verdict = deriveSwarmSessionVerdict({
      ...unrubricked,
      attempt: { status: "succeeded" },
      goalScore: { status: "completed", passed: true },
    });
    expect(verdict.counts.gating).toBe(0);
    cell(verdict);
    expect(screen.getByText("Goal result: Passed")).toBeInTheDocument();
    expect(screen.queryByText(/evaluators passed/)).not.toBeInTheDocument();
  });

  it("claims no denominator on a session the judge failed after it broke", () => {
    const verdict = deriveSwarmSessionVerdict({
      ...unrubricked,
      attempt: { status: "failed" },
      goalScore: { status: "completed", passed: false },
    });
    expect(verdict.lifecycle).toBe("broke");
    cell(verdict);
    expect(screen.getByText("Goal result: Failed")).toBeInTheDocument();
    expect(screen.queryByText(/evaluators passed/)).not.toBeInTheDocument();
  });

  it("still reports the fraction when required criteria were graded", () => {
    const verdict = deriveSwarmSessionVerdict({
      hasTranscript: true,
      attempt: { status: "succeeded" },
      rubric: [{ id: "c1", role: "required" }],
      criteria: {
        status: "completed",
        results: [{ criterionId: "c1", passed: true }],
      },
      goalScore: null,
      judge: { automatic: false, role: "advisory" },
      grading: { state: "settled" },
    });
    cell(verdict);
    expect(screen.getByText("1/1 evaluators passed")).toBeInTheDocument();
  });
});
