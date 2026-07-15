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

  it("renders card sparkline tooltips below the chart", () => {
    render(<MetricStrip data={sampleData} testId="metric-strip" />);
    const sparkline = screen.getByTestId("metric-sparkline-latency");
    fireEvent.mouseMove(sparkline, { clientX: 120 });
    const tooltip = within(sparkline).getByText("Run 2").closest(".top-full");
    expect(tooltip).toBeTruthy();
  });
});
