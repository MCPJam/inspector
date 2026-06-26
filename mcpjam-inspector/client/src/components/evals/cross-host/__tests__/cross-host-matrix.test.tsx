import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalIteration } from "../../types";
import { CrossHostMatrix } from "../cross-host-matrix";
import type { CellData, CrossHostData } from "../use-cross-host-data";

function makeIteration(id: string, toolCalls = 0, tokens = 1900): EvalIteration {
  return {
    _id: id,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 11_000,
    startedAt: 1,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    resultSource: "reported",
    actualToolCalls: Array.from({ length: toolCalls }, (_, i) => ({
      toolName: `t${i}`,
      arguments: {},
    })),
    tokensUsed: tokens,
  } as EvalIteration;
}

function makeCell(
  p50LatencyMs: number,
  tokens: number,
  toolCalls = 0,
): CellData {
  return {
    iterations: [makeIteration("i1", toolCalls, tokens)],
    passCount: 1,
    failCount: 0,
    pendingCount: 0,
    totalCount: 1,
    passRate: 100,
    p50LatencyMs,
    p95LatencyMs: p50LatencyMs,
    avgTokensPerIteration: tokens,
  };
}

function makeData(): CrossHostData {
  const matrix = new Map<string, Map<string, CellData>>([
    [
      "c-fast",
      new Map([["h1", makeCell(5000, 1000, 1)]]),
    ],
    [
      "c-slow",
      new Map([["h1", makeCell(20_000, 3000, 3)]]),
    ],
  ]);

  return {
    hostColumns: [
      { hostId: "h1", hostName: "MCPJam", isHistorical: false },
    ],
    caseRows: [
      { caseId: "c-fast", caseTitle: "Fast case" },
      { caseId: "c-slow", caseTitle: "Slow case" },
    ],
    matrix,
    hasAnyData: true,
    hasHostAttachments: true,
  };
}

describe("CrossHostMatrix row sort and summaries", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders a row summary under the case title", () => {
    render(<CrossHostMatrix data={makeData()} expanded />);
    expect(screen.getByTestId("case-row-summary-c-slow")).toHaveTextContent(
      "20s · 3k tok · 3 calls",
    );
  });

  it("hides row summaries when cellTrends is enabled", () => {
    render(<CrossHostMatrix data={makeData()} expanded cellTrends />);
    expect(
      screen.queryByTestId("case-row-summary-c-slow"),
    ).not.toBeInTheDocument();
  });

  it("fills available width while keeping a fixed case column", () => {
    const { container } = render(<CrossHostMatrix data={makeData()} expanded />);
    const table = container.querySelector("table");
    expect(table).toHaveClass("w-full", "table-fixed");
    expect(table?.querySelector("colgroup col")).toHaveAttribute(
      "style",
      expect.stringContaining("width: 300"),
    );
  });

  it("reorders rows when sorting by latency", async () => {
    const user = userEvent.setup();
    render(<CrossHostMatrix data={makeData()} expanded />);

    const rows = () =>
      screen.getAllByRole("row").slice(1).map((row) => row.textContent);

    expect(rows()[0]).toContain("Fast case");

    await user.click(screen.getByTestId("case-row-sort-trigger"));
    await user.click(screen.getByTestId("case-row-sort-latency"));

    const reordered = screen.getAllByRole("row").slice(1);
    expect(within(reordered[0]).getByText("Slow case")).toBeInTheDocument();
    expect(within(reordered[1]).getByText("Fast case")).toBeInTheDocument();
  });
});
