/**
 * Monitoring-tab gating: visible only when the synthetic-monitors flag is
 * on AND the suite has monitoring signal (a schedule or a widget probe).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SuiteDashboard } from "../suite-dashboard";
import type { EvalCase, EvalSuite } from "../types";

const flagState = { enabled: false };
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => flagState.enabled,
}));

// The dashboard composes several heavy children; this test only cares about
// the tab strip, so stub them all to inert markers.
vi.mock("../suite-runs-chart-grid", () => ({
  SuiteRunsChartGrid: () => <div data-testid="chart-grid" />,
}));
vi.mock("../suite-insights-collapsible", () => ({
  SuiteInsightsCollapsible: () => null,
}));
vi.mock("../suite-runs-list", () => ({
  SuiteRunsList: () => <div data-testid="runs-list" />,
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
    caseType: "widget_probe",
    probeConfig: { serverName: "maps", toolName: "show_map", arguments: {} },
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

describe("SuiteDashboard monitoring tab gating", () => {
  beforeEach(() => {
    flagState.enabled = false;
  });

  it("hides the tab when the flag is off, even with monitoring signal", () => {
    renderDashboard(
      makeSuite({
        schedule: { intervalMinutes: 15, enabled: true, state: "active" },
      }),
      [makeProbeCase()],
    );
    expect(screen.queryByRole("tab", { name: /monitoring/i })).toBeNull();
  });

  it("hides the tab when the flag is on but the suite has no schedule or probes", () => {
    flagState.enabled = true;
    renderDashboard(makeSuite(), []);
    expect(screen.queryByRole("tab", { name: /monitoring/i })).toBeNull();
  });

  it("shows the tab for a scheduled suite when the flag is on", () => {
    flagState.enabled = true;
    renderDashboard(
      makeSuite({
        schedule: { intervalMinutes: 15, enabled: true, state: "active" },
      }),
      [],
    );
    expect(screen.getByRole("tab", { name: /monitoring/i })).toBeTruthy();
  });

  it("shows the tab for a suite with a widget probe case (no schedule)", () => {
    flagState.enabled = true;
    renderDashboard(makeSuite(), [makeProbeCase()]);
    expect(screen.getByRole("tab", { name: /monitoring/i })).toBeTruthy();
  });

  it("falls back to a visible tab when monitoring is selected and then hidden", async () => {
    flagState.enabled = true;
    const scheduledSuite = makeSuite({
      schedule: { intervalMinutes: 15, enabled: true, state: "active" },
    });
    const view = renderDashboard(scheduledSuite, []);
    fireEvent.click(screen.getByRole("tab", { name: /monitoring/i }));
    expect(
      screen
        .getByRole("tab", { name: /monitoring/i })
        .getAttribute("aria-selected"),
    ).toBe("true");

    // Flag turns off: the tab disappears AND the selection must resolve to
    // a visible tab instead of leaving nothing highlighted.
    flagState.enabled = false;
    view.rerender(
      <SuiteDashboard
        suite={scheduledSuite}
        cases={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        runTrendData={[]}
        modelStats={[]}
        onTestCaseClick={() => {}}
        onRunClick={() => {}}
      />,
    );
    expect(screen.queryByRole("tab", { name: /monitoring/i })).toBeNull();
    expect(
      screen.getByRole("tab", { name: /cases/i }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("cases-overview")).toBeTruthy();
  });
});
