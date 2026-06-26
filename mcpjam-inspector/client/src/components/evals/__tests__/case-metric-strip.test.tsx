import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CaseMetricStrip } from "../case-metric-strip";
import { buildCaseMetricStripData } from "../metric-strip-data";
import type { CaseRunBatch } from "../runs/group-case-iterations";
import type { EvalIteration } from "../types";

function iteration(partial: Partial<EvalIteration>): EvalIteration {
  return {
    _id: "it",
    status: "completed",
    result: "passed",
    resultSource: "reported",
    tokensUsed: 0,
    actualToolCalls: [],
    startedAt: 0,
    updatedAt: 0,
    ...partial,
  } as unknown as EvalIteration;
}

function batch(
  key: string,
  createdAt: number,
  iterations: EvalIteration[],
): CaseRunBatch {
  return { key, createdAt, iterations };
}

describe("buildCaseMetricStripData", () => {
  it("returns null for an empty batch list", () => {
    expect(buildCaseMetricStripData([])).toBeNull();
  });

  it("aggregates the latest batch into headline metrics", () => {
    const batches = [
      batch("compare:new", 2_000, [
        iteration({
          _id: "b",
          result: "passed",
          tokensUsed: 2000,
          actualToolCalls: [
            { toolName: "x", arguments: {} },
            { toolName: "y", arguments: {} },
          ],
          startedAt: 1_000_000,
          updatedAt: 1_004_000,
        }),
        iteration({
          _id: "c",
          result: "failed",
          tokensUsed: 1500,
          actualToolCalls: [],
          startedAt: 1_000_000,
          updatedAt: 1_003_000,
        }),
      ]),
      batch("compare:old", 1_000, [
        iteration({
          _id: "a",
          result: "passed",
          tokensUsed: 1000,
          actualToolCalls: [{ toolName: "x", arguments: {} }],
          startedAt: 1_000_000,
          updatedAt: 1_002_000,
        }),
      ]),
    ];

    const data = buildCaseMetricStripData(batches);
    expect(data?.latest.passRate).toBe(50);
    expect(data?.latest.passed).toBe(1);
    expect(data?.latest.total).toBe(2);
    expect(data?.latest.tokens).toBe(1750);
    expect(data?.latest.toolCalls).toBe(2);
    expect(data?.showTrend).toBe(true);
  });
});

describe("CaseMetricStrip", () => {
  it("renders nothing when there are no batches", () => {
    const { container } = render(<CaseMetricStrip batches={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the shared metric strip for a case batch", () => {
    render(
      <CaseMetricStrip
        batches={[
          batch("compare:run-1", 1_000, [
            iteration({
              _id: "a",
              result: "passed",
              tokensUsed: 7800,
              actualToolCalls: [
                { toolName: "x", arguments: {} },
                { toolName: "y", arguments: {} },
                { toolName: "z", arguments: {} },
                { toolName: "w", arguments: {} },
              ],
              startedAt: 1_000_000,
              updatedAt: 1_010_400,
            }),
          ]),
        ]}
      />,
    );

    const root = screen.getByTestId("case-metric-strip");
    expect(within(root).getByText("100%")).toBeInTheDocument();
    expect(within(root).getByText("1/1 passed")).toBeInTheDocument();
    expect(within(root).getByText("7.8k")).toBeInTheDocument();
    expect(within(root).getByText("4")).toBeInTheDocument();
    expect(within(root).getAllByText("per run")).toHaveLength(3);
  });
});
