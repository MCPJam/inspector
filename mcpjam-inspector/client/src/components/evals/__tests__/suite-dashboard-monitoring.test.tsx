/**
 * Monitoring gating: the Monitoring rail item in the results split is visible
 * only when the suite has monitoring signal AND the flag owning that signal is
 * on. The rail's two halves answer to DIFFERENT flags — a schedule to
 * `scheduled-evals-enabled`, a widget probe case to `synthetic-monitors` — so
 * the mock is key-aware and each half is pinned against the other's flag too.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SuiteDashboard } from "../suite-dashboard";
import type { EvalCase, EvalSuite } from "../types";

const flagState = vi.hoisted(() => ({
  syntheticMonitors: false,
  scheduledEvals: false,
}));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (key: string) => {
    if (key === "synthetic-monitors") return flagState.syntheticMonitors;
    if (key === "scheduled-evals-enabled") return flagState.scheduledEvals;
    return false;
  },
  usePostHog: () => ({ capture: vi.fn() }),
}));

// The dashboard composes several heavy children; this test only cares about the
// Monitoring rail item, so stub the rest to inert markers.
vi.mock("../suite-insights-collapsible", () => ({
  SuiteInsightsCollapsible: () => null,
}));
vi.mock("../suite-runs-list", () => ({
  SuiteRunsList: () => <div data-testid="runs-list" />,
  computeRunEffectiveStats: () => ({
    effectivePassed: 0,
    effectiveTotal: 0,
    passRate: null,
  }),
}));
vi.mock("../test-cases-overview", () => ({
  TestCasesOverview: () => <div data-testid="cases-overview" />,
}));
vi.mock("../monitoring-tab", () => ({
  MonitoringTab: () => <div data-testid="monitoring-tab" />,
}));

function makeSuite(over: Partial<EvalSuite> = {}): EvalSuite {
  return {
    _id: "suite-1",
    createdBy: "user-1",
    name: "Suite",
    description: "",
    configRevision: "rev",
    environment: { servers: [] },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as EvalSuite;
}

function makeProbeCase(): EvalCase {
  return {
    _id: "case-1",
    testSuiteId: "suite-1",
    createdBy: "user-1",
    title: "Probe",
    query: "",
    models: [],
    runs: 1,
    expectedToolCalls: [],
    // A render check is now a model-free case: a `toolCall` step (no `prompt`
    // step) makes `isModelFree(steps)` true.
    steps: [
      {
        id: "call-1",
        kind: "toolCall",
        serverName: "maps",
        toolName: "show_map",
        arguments: {},
      },
    ],
  } as EvalCase;
}

function renderDashboard(suite: EvalSuite, cases: EvalCase[]) {
  return render(
    <SuiteDashboard
      suite={suite}
      cases={cases}
      allIterations={[]}
      runs={[]}
      runsLoading={false}
      runTrendData={[]}
      modelStats={[]}
      onTestCaseClick={() => {}}
      onRunClick={() => {}}
    />,
  );
}

const scheduledSuite = () =>
  makeSuite({
    schedule: { intervalMinutes: 15, enabled: true, state: "active" },
  });

describe("SuiteDashboard monitoring gating", () => {
  beforeEach(() => {
    flagState.syntheticMonitors = false;
    flagState.scheduledEvals = false;
  });

  it("hides the Monitoring item when both flags are off, even with signal", () => {
    renderDashboard(scheduledSuite(), [makeProbeCase()]);
    expect(screen.queryByText("Monitoring")).toBeNull();
  });

  it("hides the Monitoring item when the flags are on but there's no signal", () => {
    flagState.syntheticMonitors = true;
    flagState.scheduledEvals = true;
    renderDashboard(makeSuite(), []);
    expect(screen.queryByText("Monitoring")).toBeNull();
  });

  it("shows the Monitoring item for a scheduled suite under the schedule flag", () => {
    flagState.scheduledEvals = true;
    renderDashboard(scheduledSuite(), []);
    expect(screen.getByText("Monitoring")).toBeTruthy();
  });

  // The half the split exists for: a schedule is NOT synthetic-monitors' to
  // reveal any more, so Schedule stays dark on a deployment that has the
  // scorer kinds turned on.
  it("hides a scheduled suite's Monitoring item when only synthetic-monitors is on", () => {
    flagState.syntheticMonitors = true;
    renderDashboard(scheduledSuite(), []);
    expect(screen.queryByText("Monitoring")).toBeNull();
  });

  it("shows the Monitoring item for a widget probe case (no schedule)", () => {
    flagState.syntheticMonitors = true;
    renderDashboard(makeSuite(), [makeProbeCase()]);
    expect(screen.getByText("Monitoring")).toBeTruthy();
  });

  // And the mirror image: the schedule flag does not smuggle in the probe half.
  it("hides a probe case's Monitoring item when only the schedule flag is on", () => {
    flagState.scheduledEvals = true;
    renderDashboard(makeSuite(), [makeProbeCase()]);
    expect(screen.queryByText("Monitoring")).toBeNull();
  });

  it("opens the monitoring pane when the rail item is clicked", () => {
    flagState.scheduledEvals = true;
    renderDashboard(scheduledSuite(), []);
    fireEvent.click(screen.getByText("Monitoring"));
    expect(screen.getByTestId("monitoring-tab")).toBeTruthy();
  });
});
