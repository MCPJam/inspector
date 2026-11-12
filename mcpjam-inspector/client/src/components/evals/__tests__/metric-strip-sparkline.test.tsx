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
    expect(
      within(sparkline).getByTestId("metric-sparkline-tooltip-value"),
    ).toHaveTextContent("1k");

    fireEvent.mouseMove(sparkline, { clientX: 120 });
    expect(within(sparkline).getByText("Run 2")).toBeInTheDocument();
    expect(
      within(sparkline).getByTestId("metric-sparkline-tooltip-value"),
    ).toHaveTextContent("1.5k");

    fireEvent.mouseLeave(sparkline);
    expect(within(sparkline).queryByText("Run 1")).not.toBeInTheDocument();
  });

  it("shows latency p50 and p95 in the dual sparkline tooltip", () => {
    render(<MetricStrip data={sampleData} testId="metric-strip" />);
    const sparkline = screen.getByTestId("metric-sparkline-latency");

    fireEvent.mouseMove(sparkline, { clientX: 120 });
    expect(within(sparkline).getByText("Run 2")).toBeInTheDocument();
    expect(
      within(sparkline).getByTestId("metric-sparkline-tooltip-value"),
    ).toHaveTextContent(/P50 2\.00s · P95 4\.00s/);
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
    expect(screen.getByTestId("cell-metric-strip")).toHaveClass(
      "overflow-visible",
    );
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

  it("draws line trends in the same primary as Suite Health bars", () => {
    render(<MetricStrip data={sampleData} testId="metric-strip" />);
    expect(
      screen.getByTestId("metric-sparkline-tokens").querySelector("svg"),
    ).toHaveClass("text-primary");
    expect(
      screen.getByTestId("metric-sparkline-tokens").querySelector("polygon"),
    ).toBeTruthy();
    expect(
      screen
        .getByTestId("metric-sparkline-latency")
        .querySelector("polyline.stroke-primary"),
    ).toBeTruthy();
  });

  it("renders card sparkline tooltips below the chart", () => {
    render(<MetricStrip data={sampleData} testId="metric-strip" />);
    const sparkline = screen.getByTestId("metric-sparkline-latency");
    fireEvent.mouseMove(sparkline, { clientX: 120 });
    const tooltip = within(sparkline).getByText("Run 2").closest(".top-full");
    expect(tooltip).toBeTruthy();
  });

  it("marks the hovered bar by opacity, without a guide line or dots", () => {
    render(<MetricStrip bars data={sampleData} />);
    const latency = screen.getByTestId("metric-sparkline-latency");
    const pairOpacity = () =>
      [...latency.querySelectorAll("svg > g")].map((pair) =>
        pair.getAttribute("opacity"),
      );
    // Pairs rest dimmed like single bars, so hover reads as emphasis.
    expect(pairOpacity()).toEqual(["0.6", "0.6"]);
    for (const metric of ["latency", "pass-rate", "tokens", "tool-calls"]) {
      const chart = screen.getByTestId(`metric-sparkline-${metric}`);
      fireEvent.mouseMove(chart, { clientX: 0 });
      expect(chart.querySelector("circle")).toBeNull();
      expect(chart.querySelector("line[stroke-dasharray]")).toBeNull();
    }
    expect(pairOpacity()).toEqual(["1", "0.6"]);
  });

  it("keeps the hover dot and guide line on line sparklines", () => {
    // Point 1 of 60 sits at x≈4.9; measuring against the unpadded width
    // picked point 2 there.
    const series = Array.from({ length: 60 }, () => sampleData.series[1]);
    render(<MetricStrip data={{ ...sampleData, series }} />);
    const tokens = screen.getByTestId("metric-sparkline-tokens");
    fireEvent.mouseMove(tokens, { clientX: 5 });
    expect(within(tokens).getByText("Run 2")).toBeInTheDocument();
    expect(tokens.querySelector("circle")).toBeTruthy();
    expect(tokens.querySelector("line[stroke-dasharray]")).toBeTruthy();
  });

  it("selects the bar under the pointer across the padded plot area", () => {
    const series = Array.from({ length: 20 }, () => sampleData.series[1]);
    render(<MetricStrip bars data={{ ...sampleData, series }} />);
    const latency = screen.getByTestId("metric-sparkline-latency");
    const pairs = latency.querySelectorAll("svg > g");
    // x=7 is on the first P95 bar, past the unpadded slot boundary at x=6.
    fireEvent.mouseMove(latency, { clientX: 7 });
    expect(within(latency).getByText("Run 1")).toBeInTheDocument();
    expect(pairs[0]).toHaveAttribute("opacity", "1");
    // x=113 is on the last P50 bar, before the unpadded boundary at x=114.
    fireEvent.mouseMove(latency, { clientX: 113 });
    expect(within(latency).getByText("Run 20")).toBeInTheDocument();
    expect(pairs[19]).toHaveAttribute("opacity", "1");
  });
});

describe("MetricStrip bars", () => {
  it("places cost last and uses orange bars", () => {
    render(<MetricStrip bars data={sampleData} />);
    const labels = screen.getAllByText(/^(Latency|Tokens|Tool calls|Cost)$/);
    expect(labels.map((label) => label.textContent)).toEqual([
      "Latency",
      "Tokens",
      "Tool calls",
      "Cost",
    ]);
    expect(
      screen.getByTestId("metric-sparkline-pass-rate").querySelector("svg"),
    ).toHaveClass("text-primary");
    // Both series are primary, and the pair stays TELLABLE APART: a dual
    // sparkline whose two bars share one fill hides the shorter inside the
    // taller, which is the comparison the chart exists to make.
    const bars = [
      ...screen
        .getByTestId("metric-sparkline-latency")
        .querySelectorAll("rect[data-chart-bar]"),
    ];
    for (const bar of bars) {
      expect(bar.getAttribute("class")).toMatch(/fill-primary/);
    }
    expect(
      new Set(bars.map((bar) => bar.getAttribute("class"))).size,
    ).toBeGreaterThan(1);
  });

  it("uses zero-based bars without trend lines across the metric row", () => {
    render(<MetricStrip bars data={sampleData} />);
    for (const metric of ["pass-rate", "tokens", "tool-calls"]) {
      const chart = screen.getByTestId(`metric-sparkline-${metric}`);
      expect(chart.querySelectorAll("rect[data-chart-bar=value]")).toHaveLength(
        2,
      );
      expect(chart.querySelector("polyline")).toBeNull();
    }
    const bars = screen
      .getByTestId("metric-sparkline-pass-rate")
      .querySelectorAll("rect");
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
    expect(Number(primary[1].getAttribute("height"))).toBe(
      Number(secondary[1].getAttribute("height")) / 2,
    );
  });

  it("keeps zero values at the baseline", () => {
    render(
      <MetricStrip
        bars
        data={{
          ...sampleData,
          series: sampleData.series.map((point) => ({
            ...point,
            toolCalls: 0,
          })),
        }}
      />,
    );
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
  expect(screen.getByTestId("metric-strip").className).toContain(
    "sm:grid-cols-[1.4fr_1fr_1fr_1fr]",
  );
});
