import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CellTrendPoint } from "../use-cross-host-data";
import { buildTrendSummary, RunTrendStrip } from "../run-trend-strip";

function point(
  id: string,
  result: CellTrendPoint["result"],
): CellTrendPoint {
  return {
    runId: id,
    runLabel: id,
    timestamp: 1,
    result,
    latencyMs: 1000,
    latencyP95Ms: 1200,
    tokens: 100,
    toolCalls: 1,
  };
}

describe("buildTrendSummary", () => {
  it("describes an all-pass streak", () => {
    expect(
      buildTrendSummary([
        point("r1", "passed"),
        point("r2", "passed"),
      ]),
    ).toBe("All 2 runs passed");
  });

  it("describes a mixed history", () => {
    expect(
      buildTrendSummary([
        point("r1", "passed"),
        point("r2", "failed"),
        point("r3", "passed"),
      ]),
    ).toBe("2/3 runs passed");
  });

  it("describes an all-fail streak", () => {
    expect(
      buildTrendSummary([point("r1", "failed"), point("r2", "failed")]),
    ).toBe("All 2 runs failed");
  });
});

describe("RunTrendStrip", () => {
  it("renders a segment per run with an aria summary", () => {
    const { container } = render(
      <RunTrendStrip
        series={[
          point("r1", "passed"),
          point("r2", "failed"),
          point("r3", "passed"),
        ]}
      />,
    );
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "2 passed, 1 failed out of 3 runs",
    );
    const segments = container.querySelectorAll("span[aria-hidden].rounded-\\[2px\\]");
    expect(segments).toHaveLength(3);
  });

  it("caps visible segments at 12", () => {
    const series = Array.from({ length: 15 }, (_, index) =>
      point(`r${index}`, "passed"),
    );
    const { container } = render(<RunTrendStrip series={series} />);
    const segments = container.querySelectorAll("span[aria-hidden].rounded-\\[2px\\]");
    expect(segments).toHaveLength(12);
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "15 passed, 0 failed out of 15 runs (3 older not shown)",
    );
  });

  it("renders an empty-state aria-label when no runs", () => {
    render(<RunTrendStrip series={[]} />);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "No runs");
  });
});
