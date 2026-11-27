import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConformanceScore } from "@mcpjam/sdk/browser";
import { useConformanceRunCompleted } from "../use-conformance-run-completed";

const { track, requestGitHubStarPrompt } = vi.hoisted(() => ({
  track: vi.fn(),
  requestGitHubStarPrompt: vi.fn(),
}));
vi.mock("@/lib/analytics", () => ({ track }));
vi.mock("@/lib/github-star-prompt", () => ({ requestGitHubStarPrompt }));

function score(
  outcome: ConformanceScore["outcome"],
  advisories = 0,
): ConformanceScore {
  return {
    score: 100,
    outcome,
    applicable: 1,
    passed: 1,
    failed: 0,
    couldNotRun: 0,
    notApplicable: 0,
    pending: 0,
    advisories: Array.from({ length: advisories }, () => ({}) as never),
    advicePointsLost: 0,
  };
}

function runThenFinish(finalScore: ConformanceScore | undefined) {
  const { rerender } = renderHook(
    ({ running, value }) => useConformanceRunCompleted(running, value),
    {
      initialProps: {
        running: false,
        value: undefined as ConformanceScore | undefined,
      },
    },
  );
  rerender({ running: true, value: undefined });
  rerender({ running: false, value: finalScore });
  return rerender;
}

beforeEach(() => {
  track.mockClear();
  requestGitHubStarPrompt.mockClear();
});

describe("useConformanceRunCompleted", () => {
  it("reports a passing run and asks for a star", () => {
    runThenFinish(score("passed", 2));
    expect(track).toHaveBeenCalledWith("conformance_run_completed", {
      location: "conformance_tab",
      run_source: "ui",
      outcome: "passed",
      has_advice: true,
      scored: true,
    });
    expect(requestGitHubStarPrompt).toHaveBeenCalledWith({
      trigger: "conformance",
      reason: "completed",
      hasAdvice: true,
    });
  });

  it("asks for a star after a failed run that produced a score", () => {
    runThenFinish(score("failed"));
    expect(requestGitHubStarPrompt).toHaveBeenCalledWith({
      trigger: "conformance",
      reason: "completed",
      hasAdvice: false,
    });
  });

  it("reports an incomplete run without asking for a star", () => {
    runThenFinish(score("incomplete"));
    expect(track).toHaveBeenCalledWith(
      "conformance_run_completed",
      expect.objectContaining({ outcome: "incomplete" }),
    );
    expect(requestGitHubStarPrompt).not.toHaveBeenCalled();
  });

  it("does not ask for a star when nothing was applicable", () => {
    runThenFinish({ ...score("passed"), score: null, applicable: 0 });
    expect(requestGitHubStarPrompt).not.toHaveBeenCalled();
  });

  it("ignores a finished run it never saw running", () => {
    renderHook(() => useConformanceRunCompleted(false, score("passed")));
    expect(track).not.toHaveBeenCalled();
    expect(requestGitHubStarPrompt).not.toHaveBeenCalled();
  });

  it("reports once per run, not on later score updates", () => {
    const rerender = runThenFinish(score("passed"));
    rerender({ running: false, value: score("passed", 1) });
    expect(track).toHaveBeenCalledTimes(1);
  });
});
