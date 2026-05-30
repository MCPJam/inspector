import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalRunDiff } from "../types";
import { RunDiffView } from "../run-diff-view";

const mocks = vi.hoisted(() => ({
  getRunDiff: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useAction: () => mocks.getRunDiff,
}));

function makeDiff(): EvalRunDiff {
  return {
    suite: { id: "suite-1", name: "Checkout Suite", source: "ui" },
    baseRun: {
      id: "base-run-123",
      runNumber: 1,
      source: "ui",
      framework: null,
      createdAt: 1_000,
      completedAt: 2_000,
      result: "passed",
      summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    },
    compareRun: {
      id: "compare-run-456",
      runNumber: 2,
      source: "ui",
      framework: null,
      createdAt: 3_000,
      completedAt: 5_000,
      result: "failed",
      summary: { total: 1, passed: 0, failed: 1, passRate: 0 },
    },
    metrics: {
      startOffsetMs: { base: -2_000, compare: 0, delta: 2_000, percentDelta: -100 },
      wallDurationMs: { base: 1_000, compare: 2_000, delta: 1_000, percentDelta: 100 },
      totalTokens: { base: 10, compare: 12, delta: 2, percentDelta: 20 },
      inputTokens: { base: 4, compare: 5, delta: 1, percentDelta: 25 },
      outputTokens: { base: 6, compare: 7, delta: 1, percentDelta: 16.666 },
      cachedInputTokens: { base: null, compare: null, delta: null, percentDelta: null },
      reasoningTokens: { base: null, compare: null, delta: null, percentDelta: null },
      estimatedCostUsd: { base: 0.001, compare: 0.002, delta: 0.001, percentDelta: 100 },
    },
    scores: {
      passRatePercent: { base: 100, compare: 0, delta: -100, percentDelta: -100 },
      total: { base: 1, compare: 1, delta: 0, percentDelta: 0 },
      passed: { base: 1, compare: 0, delta: -1, percentDelta: -100 },
      failed: { base: 0, compare: 1, delta: 1, percentDelta: null },
    },
    cases: [
      {
        caseKey: "case-1",
        title: "Find checkout total",
        testCaseId: "case-doc-1",
        status: "regressed",
        configChanged: false,
        base: {
          outcome: "passed",
          iterationIds: ["iter-base"],
          representativeIterationId: "iter-base",
          traceBlobIds: ["blob-base"],
          input: { text: "Base prompt", truncated: false },
          output: { text: "Base answer", truncated: false },
          expectedToolCalls: [],
          actualToolCalls: [],
          error: null,
          metrics: {
            durationMs: 1_000,
            totalTokens: 10,
            inputTokens: 4,
            outputTokens: 6,
            cachedInputTokens: null,
            reasoningTokens: null,
            estimatedCostUsd: 0.001,
          },
        },
        compare: {
          outcome: "failed",
          iterationIds: ["iter-compare"],
          representativeIterationId: "iter-compare",
          traceBlobIds: ["blob-compare"],
          input: { text: "Compare prompt", truncated: false },
          output: { text: "Compare answer", truncated: false },
          expectedToolCalls: [],
          actualToolCalls: [{ toolName: "search", arguments: {} }],
          error: null,
          metrics: {
            durationMs: 2_000,
            totalTokens: 12,
            inputTokens: 5,
            outputTokens: 7,
            cachedInputTokens: null,
            reasoningTokens: null,
            estimatedCostUsd: 0.002,
          },
        },
        metrics: {
          durationMs: { base: 1_000, compare: 2_000, delta: 1_000, percentDelta: 100 },
          totalTokens: { base: 10, compare: 12, delta: 2, percentDelta: 20 },
          inputTokens: { base: 4, compare: 5, delta: 1, percentDelta: 25 },
          outputTokens: { base: 6, compare: 7, delta: 1, percentDelta: 16.666 },
          cachedInputTokens: { base: null, compare: null, delta: null, percentDelta: null },
          reasoningTokens: { base: null, compare: null, delta: null, percentDelta: null },
          estimatedCostUsd: { base: 0.001, compare: 0.002, delta: 0.001, percentDelta: 100 },
        },
      },
    ],
  };
}

describe("RunDiffView", () => {
  beforeEach(() => {
    mocks.getRunDiff.mockReset();
    mocks.getRunDiff.mockResolvedValue(makeDiff());
  });

  it("loads and renders run diff rows", async () => {
    render(
      <RunDiffView
        baseRunId="base-run-123"
        compareRunId="compare-run-456"
        onOpenIteration={vi.fn()}
      />,
    );

    expect(await screen.findByText("Find checkout total")).toBeInTheDocument();
    expect(screen.getByText("Regressed")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /View trace/i })).toHaveLength(2);
    expect(mocks.getRunDiff).toHaveBeenCalledWith({
      baseRunId: "base-run-123",
      compareRunId: "compare-run-456",
      previewChars: 0,
    });
  });

  it("opens representative iterations from each side", async () => {
    const onOpenIteration = vi.fn();
    render(
      <RunDiffView
        baseRunId="base-run-123"
        compareRunId="compare-run-456"
        onOpenIteration={onOpenIteration}
      />,
    );

    const user = userEvent.setup();
    const traceButtons = await screen.findAllByRole("button", {
      name: /View trace/i,
    });
    await user.click(traceButtons[1]);

    expect(onOpenIteration).toHaveBeenCalledWith(
      "compare-run-456",
      "iter-compare",
    );
  });
});
