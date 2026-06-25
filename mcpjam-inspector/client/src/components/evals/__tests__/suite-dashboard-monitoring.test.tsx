/**
 * Monitoring gating: the Monitoring rail item in the results split is visible
 * only when the synthetic-monitors flag is on AND the suite has monitoring
 * signal (a schedule or a widget probe case).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SuiteDashboard } from "../suite-dashboard";
import type { EvalCase, EvalSuite } from "../types";

const flagState = { enabled: false };
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => flagState.enabled,
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

describe("SuiteDashboard monitoring gating", () => {
  beforeEach(() => {
    flagState.enabled = false;
  });

  it("hides the Monitoring item when the flag is off, even with signal", () => {
    renderDashboard(
      makeSuite({
        schedule: { intervalMinutes: 15, enabled: true, state: "active" },
      }),
      [makeProbeCase()],
    );
    expect(screen.queryByText("Monitoring")).toBeNull();
  });

  it("hides the Monitoring item when the flag is on but there's no signal", () => {
    flagState.enabled = true;
    renderDashboard(makeSuite(), []);
    expect(screen.queryByText("Monitoring")).toBeNull();
  });

  it("shows the Monitoring item for a scheduled suite when the flag is on", () => {
    flagState.enabled = true;
    renderDashboard(
      makeSuite({
        schedule: { intervalMinutes: 15, enabled: true, state: "active" },
      }),
      [],
    );
    expect(screen.getByText("Monitoring")).toBeTruthy();
  });

  it("shows the Monitoring item for a widget probe case (no schedule)", () => {
    flagState.enabled = true;
    renderDashboard(makeSuite(), [makeProbeCase()]);
    expect(screen.getByText("Monitoring")).toBeTruthy();
  });

  it("opens the monitoring pane when the rail item is clicked", () => {
    flagState.enabled = true;
    renderDashboard(
      makeSuite({
        schedule: { intervalMinutes: 15, enabled: true, state: "active" },
      }),
      [],
    );
    fireEvent.click(screen.getByText("Monitoring"));
    expect(screen.getByTestId("monitoring-tab")).toBeTruthy();
  });
});
