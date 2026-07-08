import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent } from "@/test";
import {
  SuiteInsightsCollapsible,
  type InsightGroupScope,
} from "../suite-insights-collapsible";
import type { EvalSuiteRun, RunGroupQualityResult } from "../types";

// The banner switches data sources by scope. Mock BOTH hooks so we can drive
// the cross-host branch and assert run-insights stays untouched.
let groupState: any;
const groupRequestSpy = vi.fn();
vi.mock("../use-run-group-quality", () => ({
  useRunGroupQuality: () => groupState,
}));
// Capture the run handed to useRunInsights so we can assert the banner follows
// the selected run rather than always the latest.
const runInsightsSpy = vi.fn();
vi.mock("../use-run-insights", () => ({
  useRunInsights: (run: any) => {
    runInsightsSpy(run);
    return {
      summary: "RUN-INSIGHTS-SUMMARY",
      pending: false,
      failedGeneration: false,
      requestRunInsights: vi.fn(),
      unavailable: false,
      requested: false,
      errorMessage: null,
    };
  },
}));

const copySpy = vi.fn().mockResolvedValue(true);
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (t: string) => copySpy(t),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const scope: InsightGroupScope = {
  suiteId: "s1",
  runGroupId: "g1",
  runs: [
    { _id: "r1", status: "completed" },
    { _id: "r2", status: "completed" },
  ] as unknown as EvalSuiteRun[],
};

const runs = [
  { _id: "r1", status: "completed", runNumber: 1 },
] as unknown as EvalSuiteRun[];

const result: RunGroupQualityResult = {
  summary: "Copilot diverged from ChatGPT on cart flows.",
  generatedAt: 1,
  modelUsed: "gpt-5.4-mini",
  runIds: ["r1", "r2"],
  findings: [
    {
      title: "Copilot skipped add_to_cart",
      severity: "critical",
      category: "host_divergence",
      attribution: "model_behavior",
      confidence: "high",
      affectedHosts: ["Copilot"],
      baselineHosts: ["ChatGPT"],
      evidence: ["Copilot: failed, 1 call"],
      recommendation: "Strengthen the add_to_cart tool description.",
    },
  ],
  hostSummaries: [],
};

function baseGroup(overrides: Partial<any> = {}) {
  return {
    result: undefined,
    status: undefined,
    pending: false,
    failedGeneration: false,
    error: null,
    requested: false,
    unavailable: false,
    allRunsTerminal: true,
    canRequest: true,
    request: groupRequestSpy,
    cancel: vi.fn(),
    ...overrides,
  };
}

// Two completed runs with distinct timestamps so pickLatestCompletedRun is
// unambiguous and run-selection is observable.
const multiRuns = [
  {
    _id: "rOld",
    status: "completed",
    runNumber: 1,
    completedAt: 100,
    createdAt: 100,
  },
  {
    _id: "rNew",
    status: "completed",
    runNumber: 2,
    completedAt: 200,
    createdAt: 200,
  },
] as unknown as EvalSuiteRun[];

beforeEach(() => {
  groupRequestSpy.mockClear();
  copySpy.mockClear();
  runInsightsSpy.mockClear();
});

describe("SuiteInsightsCollapsible scope adaptivity", () => {
  it("shows run insights when no group scope is provided", () => {
    groupState = baseGroup();
    renderWithProviders(<SuiteInsightsCollapsible runs={runs} />);
    expect(screen.getByText("Run insights")).toBeInTheDocument();
    expect(screen.getByText("RUN-INSIGHTS-SUMMARY")).toBeInTheDocument();
    expect(screen.queryByText("Cross-host insights")).not.toBeInTheDocument();
  });

  it("shows the latest completed run's insights when no run is selected", () => {
    groupState = baseGroup();
    renderWithProviders(<SuiteInsightsCollapsible runs={multiRuns} />);
    expect(runInsightsSpy).toHaveBeenCalled();
    const lastRun = runInsightsSpy.mock.calls.at(-1)![0];
    expect(lastRun?._id).toBe("rNew");
  });

  it("follows the selected run instead of the latest", () => {
    groupState = baseGroup();
    renderWithProviders(
      <SuiteInsightsCollapsible runs={multiRuns} selectedRunId="rOld" />,
    );
    const lastRun = runInsightsSpy.mock.calls.at(-1)![0];
    expect(lastRun?._id).toBe("rOld");
  });

  it("switches to cross-host diagnosis when a group is selected", () => {
    groupState = baseGroup({ status: "completed", result });
    renderWithProviders(
      <SuiteInsightsCollapsible runs={runs} groupScope={scope} />,
    );
    expect(screen.getByText("Cross-host insights")).toBeInTheDocument();
    expect(
      screen.getByText("Copilot diverged from ChatGPT on cart flows."),
    ).toBeInTheDocument();
    // The run-insights summary must NOT render in group mode.
    expect(screen.queryByText("RUN-INSIGHTS-SUMMARY")).not.toBeInTheDocument();
  });

  it("reveals findings (and copies a grounded fix prompt) under show more", () => {
    groupState = baseGroup({ status: "completed", result });
    renderWithProviders(
      <SuiteInsightsCollapsible runs={runs} groupScope={scope} />,
    );
    // Findings hidden until expanded.
    expect(
      screen.queryByText("Copilot skipped add_to_cart"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Show 1 cross-host finding"));
    expect(screen.getByText("Copilot skipped add_to_cart")).toBeInTheDocument();

    fireEvent.click(
      screen.getByLabelText("Copy fix prompt: Copilot skipped add_to_cart"),
    );
    const text = copySpy.mock.calls[0][0] as string;
    expect(text).toContain("Model behavior");
    expect(text).toContain("Affected host(s): Copilot");
    expect(text).toContain("Strengthen the add_to_cart tool description.");
  });

  it("waits for all sibling runs before diagnosing", () => {
    groupState = baseGroup({ allRunsTerminal: false });
    renderWithProviders(
      <SuiteInsightsCollapsible runs={runs} groupScope={scope} />,
    );
    expect(
      screen.getByText(/once every host in this group has finished/i),
    ).toBeInTheDocument();
  });

  it("renders nothing in group mode when the feature is unavailable", () => {
    groupState = baseGroup({ unavailable: true });
    const { container } = renderWithProviders(
      <SuiteInsightsCollapsible runs={runs} groupScope={scope} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("retries a failed cross-host analysis via request(true)", () => {
    groupState = baseGroup({
      status: "failed",
      failedGeneration: true,
      error: "Cross-host analysis failed. Please try again later.",
    });
    renderWithProviders(
      <SuiteInsightsCollapsible runs={runs} groupScope={scope} />,
    );
    fireEvent.click(screen.getByText("Retry"));
    expect(groupRequestSpy).toHaveBeenCalledWith(true);
  });
});
