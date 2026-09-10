import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MetricStrip } from "../metric-strip";
import type { MetricStripData } from "../metric-strip-data";

const sampleData: MetricStripData = {
  latest: {
    passRate: 50,
    passed: 1,
    total: 2,
    failed: 1,
    latencyP50: 2_000,
    latencyP95: 4_000,
    tokens: 1_500,
    toolCalls: 2,
    costUsd: null,
    costedIterations: 0,
  },
  series: [
    {
      passRate: 100,
      passed: 1,
      total: 1,
      failed: 0,
      latencyP50: 1_000,
      latencyP95: 1_500,
      tokens: 1_000,
      toolCalls: 1,
      costUsd: null,
      costedIterations: 0,
    },
    {
      passRate: 50,
      passed: 1,
      total: 2,
      failed: 1,
      latencyP50: 2_000,
      latencyP95: 4_000,
      tokens: 1_500,
      toolCalls: 2,
      costUsd: null,
      costedIterations: 0,
    },
  ],
  delta: -50,
  showTrend: true,
};

describe("MetricStrip sparkline hover", () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 120,
      bottom: 24,
      width: 120,
      height: 24,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a tooltip with the hovered run's token value", () => {
    render(<MetricStrip data={sampleData} testId="metric-strip" />);
    const sparkline = screen.getByTestId("metric-sparkline-tokens");

    fireEvent.mouseMove(sparkline, { clientX: 0 });
    expect(within(sparkline).getByText("Run 1")).toBeInTheDocument();
    expect(within(sparkline).getByTestId("metric-sparkline-tooltip-value")).toHaveTextContent("1k");

    fireEvent.mouseMove(sparkline, { clientX: 120 });
    expect(within(sparkline).getByText("Run 2")).toBeInTheDocument();
    expect(within(sparkline).getByTestId("metric-sparkline-tooltip-value")).toHaveTextContent("1.5k");

    fireEvent.mouseLeave(sparkline);
    expect(within(sparkline).queryByText("Run 1")).not.toBeInTheDocument();
  });

  it("shows latency p50 and p95 in the dual sparkline tooltip", () => {
    render(<MetricStrip data={sampleData} testId="metric-strip" />);
    const sparkline = screen.getByTestId("metric-sparkline-latency");

    fireEvent.mouseMove(sparkline, { clientX: 120 });
    expect(within(sparkline).getByText("Run 2")).toBeInTheDocument();
    expect(within(sparkline).getByTestId("metric-sparkline-tooltip-value")).toHaveTextContent(
      /P50 2\.00s · P95 4\.00s/,
    );
  });

  it("stacks latency values in embedded matrix cells", () => {
    render(
      <MetricStrip
        data={sampleData}
        density="compact"
        layout="vertical"
        surface="embedded"
        testId="cell-metric-strip"
      />,
    );
    const latency = screen.getByTestId("metric-strip-latency");
    expect(within(latency).getByText("P50")).toBeInTheDocument();
    expect(within(latency).getByText("P95")).toBeInTheDocument();
    expect(within(latency).queryByText("per run")).not.toBeInTheDocument();
  });

  it("allows sparkline tooltips to escape embedded matrix cells", () => {
    render(
      <MetricStrip
        data={sampleData}
        density="compact"
        layout="vertical"
        surface="embedded"
        testId="cell-metric-strip"
      />,
    );
    expect(screen.getByTestId("cell-metric-strip")).toHaveClass("overflow-visible");
  });

  it("shows the full run label when hovering the first sparkline point", () => {
    render(
      <MetricStrip
        data={sampleData}
        density="compact"
        layout="vertical"
        surface="embedded"
        testId="cell-metric-strip"
      />,
    );
    const sparkline = screen.getByTestId("metric-sparkline-latency");
    fireEvent.mouseMove(sparkline, { clientX: 0 });
    expect(within(sparkline).getByText("Run 1")).toBeInTheDocument();
  });

  it("omits failed-iteration and point-change chips in history context", () => {
    render(
      <MetricStrip data={sampleData} context="history" testId="metric-strip" />,
    );
    expect(screen.queryByText(/failed iteration/)).toBeNull();
    expect(screen.queryByText(/pp/)).toBeNull();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("1/2 passed")).toBeInTheDocument();
  });

  it("renders card sparkline tooltips below the chart", () => {
    render(<MetricStrip data={sampleData} testId="metric-strip" />);
    const sparkline = screen.getByTestId("metric-sparkline-latency");
    fireEvent.mouseMove(sparkline, { clientX: 120 });
    const tooltip = within(sparkline).getByText("Run 2").closest(".top-full");
    expect(tooltip).toBeTruthy();
  });
});

describe("MetricStrip bars", () => {
  it("uses zero-based bars without trend lines across the metric row", () => {
    render(<MetricStrip bars data={sampleData} />);
    for (const metric of ["pass-rate", "tokens", "tool-calls"]) {
      const chart = screen.getByTestId(`metric-sparkline-${metric}`);
      expect(chart.querySelectorAll("rect[data-chart-bar=value]")).toHaveLength(2);
      expect(chart.querySelector("polyline")).toBeNull();
    }
    const bars = screen.getByTestId("metric-sparkline-pass-rate").querySelectorAll("rect");
    const heights = [...bars].map((bar) => Number(bar.getAttribute("height")));
    // 50% is half the height of 100%, rather than appearing as zero.
    expect(heights[1]).toBe(heights[0] / 2);
  });

  it("compares P50 and P95 on a shared scale", () => {
    render(<MetricStrip bars data={sampleData} />);
    const chart = screen.getByTestId("metric-sparkline-latency");
    expect(chart.querySelector("polyline")).toBeNull();
    const primary = [...chart.querySelectorAll('[data-chart-bar="p50"]')];
    const secondary = [...chart.querySelectorAll('[data-chart-bar="p95"]')];
    expect(primary).toHaveLength(2);
    expect(secondary).toHaveLength(2);
    expect(Number(primary[1].getAttribute("height"))).toBe(Number(secondary[1].getAttribute("height")) / 2);
  });

  it("keeps zero values at the baseline", () => {
    render(<MetricStrip bars data={{ ...sampleData, series: sampleData.series.map((point) => ({ ...point, toolCalls: 0 })) }} />);
    const chart = screen.getByTestId("metric-sparkline-tool-calls");
    for (const bar of chart.querySelectorAll("rect")) {
      expect(bar).toHaveAttribute("height", "0");
      expect(bar.getAttribute("y")).not.toBe("NaN");
    }
  });
});

it("keeps line graphs as the default for the original Evals surfaces", () => {
  render(<MetricStrip data={sampleData} />);
  for (const metric of ["pass-rate", "latency", "tokens", "tool-calls"]) {
    const chart = screen.getByTestId(`metric-sparkline-${metric}`);
    expect(chart.querySelector("polyline")).not.toBeNull();
    expect(chart.querySelector("rect[data-chart-bar]")).toBeNull();
  }
});

it("can omit the suite summary cost block and use four columns", () => {
  render(<MetricStrip data={sampleData} showCost={false} />);
  expect(screen.queryByText("Cost")).toBeNull();
  expect(screen.queryByText("not priced")).toBeNull();
  expect(screen.getByText("Tokens")).toBeVisible();
  expect(screen.getByTestId("metric-strip").className).toContain("sm:grid-cols-[1.4fr_1fr_1fr_1fr]");
});
