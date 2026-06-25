import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CrossHostMatrix,
  type HostVerdictMap,
} from "../cross-host-matrix";
import type { CellData, CrossHostData } from "../use-cross-host-data";

function makeCell(): CellData {
  return {
    iterations: [],
    passCount: 1,
    failCount: 0,
    pendingCount: 0,
    totalCount: 1,
    passRate: 100,
    p50LatencyMs: 1000,
    p95LatencyMs: 1000,
    avgTokensPerIteration: 100,
  };
}

// Three hosts: one with a strong verdict, one "incomplete" (must hide), one
// with no verdict entry at all (must render nothing).
function makeData(): CrossHostData {
  const row = new Map<string, CellData>([
    ["chatgpt", makeCell()],
    ["copilot", makeCell()],
    ["mcpjam", makeCell()],
  ]);
  return {
    hostColumns: [
      { hostId: "chatgpt", hostName: "ChatGPT", isHistorical: false },
      { hostId: "copilot", hostName: "Copilot", isHistorical: false },
      { hostId: "mcpjam", hostName: "MCPJam", isHistorical: false },
    ],
    caseRows: [{ caseId: "c1", caseTitle: "Add to cart" }],
    matrix: new Map([["c1", row]]),
    hasAnyData: true,
    hasHostAttachments: true,
  } as CrossHostData;
}

describe("CrossHostMatrix host verdicts", () => {
  it("renders the per-host verdict label, hides 'incomplete', and omits hosts without a verdict", () => {
    const verdicts: HostVerdictMap = new Map([
      ["chatgpt", { verdict: "strong", summary: "Solid across the board." }],
      ["copilot", { verdict: "incomplete", summary: "Run failed early." }],
      // mcpjam intentionally absent.
    ]);
    render(<CrossHostMatrix data={makeData()} hostVerdicts={verdicts} />);

    // Strong verdict surfaces (label is the verdict text).
    const strong = screen.getByText("strong");
    expect(strong).toBeInTheDocument();
    expect(strong).toHaveAttribute("title", "Solid across the board.");

    // "incomplete" is judge noise and must never render.
    expect(screen.queryByText("incomplete")).not.toBeInTheDocument();
  });

  it("renders no verdict labels when none are supplied", () => {
    render(<CrossHostMatrix data={makeData()} />);
    expect(screen.queryByText("strong")).not.toBeInTheDocument();
    expect(screen.queryByText("mixed")).not.toBeInTheDocument();
    expect(screen.queryByText("weak")).not.toBeInTheDocument();
  });
});
