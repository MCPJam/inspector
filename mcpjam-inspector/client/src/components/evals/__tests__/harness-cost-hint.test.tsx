import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunCostEstimateHint } from "../run-cost-estimate-hint";
import type { RunCostEstimate } from "@/hooks/use-run-cost-estimate";

const base: RunCostEstimate = {
  credits: 900,
  lowerBoundCredits: 900,
  usd: 9,
  coverage: "full",
  confidence: "partial",
  sampleCount: 8,
  truncated: false,
  lines: [],
};

function show(estimate: RunCostEstimate) {
  render(
    <RunCostEstimateHint
      state={{
        status: "ready",
        estimate,
        error: null,
        open: true,
        setOpen: vi.fn(),
      }}
    />,
  );
}

afterEach(cleanup);

describe("harness cost context", () => {
  it("shows the historical AI range with exclusions and no spending guarantee", () => {
    show({
      ...base,
      harnessCost: {
        clientAiCreditsRange: { low: 400, high: 1400, sampleCount: 8 },
      },
    });
    expect(
      screen.getAllByText("Partial harness estimate").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Likely client AI range: 400 to 1,400 credits/)
        .length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        /excludes computer time, other models and tool provider fees/,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/total can be higher or lower.*not a spending limit/)
        .length,
    ).toBeGreaterThan(0);
  });

  it("does not invent a range when history is insufficient", () => {
    show({ ...base, harnessCost: { clientAiCreditsRange: null } });
    expect(
      screen.getAllByText(
        "Not enough priced history to show a client AI range. Choose a priced model and run more evals or swarms to build history.",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Likely client AI range/)).toBeNull();
  });

  it("preserves estimates without harness metadata", () => {
    show(base);
    expect(screen.queryByText("Partial harness estimate")).toBeNull();
    expect(screen.queryByText(/client AI range/)).toBeNull();
    expect(
      screen.getAllByText(/Estimated: ~900 credits/).length,
    ).toBeGreaterThan(0);
  });
});
