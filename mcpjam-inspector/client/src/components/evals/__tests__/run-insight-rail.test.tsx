import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RunAccuracyHeroBand,
  RunDetailMetricsCharts,
  RunInsightRail,
} from "../run-insight-rail";
import type { EvalIteration, EvalSuiteRun } from "../types";

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-2",
    suiteId: "suite-1",
    createdBy: "user",
    runNumber: 2,
    configRevision: "rev1",
    configSnapshot: {
      tests: [],
      environment: { servers: [] },
    },
    status: "completed",
    createdAt: 1,
    completedAt: 2,
    summary: { total: 10, passed: 7, failed: 3, passRate: 0.7 },
    ...overrides,
  };
}

function makeIteration(overrides: Partial<EvalIteration> = {}): EvalIteration {
  return {
    _id: "iter-1",
    createdBy: "user",
    createdAt: 1,
    iterationNumber: 1,
    updatedAt: 2,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 100,
    testCaseSnapshot: {
      title: "Test A",
      query: "q",
      provider: "openai",
      model: "gpt-4",
      expectedToolCalls: [],
    },
    ...overrides,
  };
}

const trendFixture = [
  {
    runId: "run-1",
    runIdDisplay: "run-1",
    passRate: 80,
    label: "a",
    runNumber: 1,
  },
  {
    runId: "run-2",
    runIdDisplay: "run-2",
    passRate: 70,
    label: "b",
    runNumber: 2,
  },
];

describe("RunAccuracyHeroBand", () => {
  it("renders large accuracy with recent run cards (delta + compare button intentionally suppressed in the header)", () => {
    render(
      <RunAccuracyHeroBand
        run={makeRun()}
        iterations={[]}
        compareBaseRun={makeRun({
          _id: "run-1",
          runNumber: 1,
          summary: { total: 10, passed: 8, failed: 2, passRate: 0.8 },
        })}
        runTrendData={trendFixture}
        metricLabel="Accuracy"
      />,
    );

    expect(screen.getByText("Accuracy")).toBeInTheDocument();
    expect(screen.queryByText(/pp vs run #/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Compare to previous run/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Recent runs")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Accuracy across recent suite runs"),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle("Run run-2, 70% accuracy, Current run"),
    ).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  it("renders client chip when runClient is set", () => {
    render(
      <RunAccuracyHeroBand
        run={makeRun()}
        iterations={[]}
        metricLabel="Accuracy"
        includeRunIdentity
        compareBaseRun={null}
        runTrendData={[]}
        runClient={{ hostId: "host-chatgpt", displayName: "ChatGPT" }}
      />,
    );

    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
  });

  it("renders run identity when includeRunIdentity is set", () => {
    render(
      <RunAccuracyHeroBand
        run={makeRun({
          result: "failed",
          passCriteria: { minimumPassRate: 100 },
        })}
        iterations={[]}
        metricLabel="Accuracy"
        badgeMetricLabel="Accuracy"
        includeRunIdentity
        compareBaseRun={null}
        runTrendData={[]}
      />,
    );

    expect(screen.getByRole("heading", { name: /Run run-2/i })).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/7 passed · 3 failed ·/)).toBeInTheDocument();
    const band = screen.getByRole("heading", { name: /Run run-2/i }).closest("section");
    expect(band).toHaveTextContent("Accuracy");
    expect(band).toHaveTextContent("70%");
  });

  it("navigates when a non-current run card is clicked", async () => {
    const user = userEvent.setup();
    const onSelectRun = vi.fn();

    render(
      <RunAccuracyHeroBand
        run={makeRun()}
        iterations={[]}
        metricLabel="Accuracy"
        compareBaseRun={null}
        runTrendData={trendFixture}
        onSelectRun={onSelectRun}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: /Open Run run-1, 80% accuracy, Suite run #1/,
      }),
    );
    expect(onSelectRun).toHaveBeenCalledWith("run-1");
  });
});

describe("RunInsightRail", () => {
  it("renders triage only (charts live below the run hero band)", () => {
    render(
      <RunInsightRail
        triageCard={<div data-testid="triage-slot">Insights</div>}
      />,
    );

    expect(screen.getByTestId("triage-slot")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Latency by test (p50 / p95)" }),
    ).not.toBeInTheDocument();
  });
});

describe("RunDetailMetricsCharts", () => {
  it("renders duration and token chart headings", () => {
    render(
      <RunDetailMetricsCharts
        durationData={[
          {
            name: "Test",
            p50Ms: 3000,
            p95Ms: 5000,
            p50Seconds: 3,
            p95TailSeconds: 2,
          },
        ]}
        tokensData={[
          {
            name: "Test",
            inputP50: 500,
            outputP50: 1500,
            inputP95Tail: 0,
            outputP95Tail: 500,
          },
        ]}
        hasTokenData
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Latency by test (p50 / p95)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Tokens by test (p50 / p95)" }),
    ).toBeInTheDocument();
  });
});
