import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EvalSuite, EvalSuiteOverviewEntry, EvalSuiteRun } from "../types";

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

vi.mock("@/lib/scenario-client-style", () => ({
  resolveHostLogoByDisplayName: () => "logo.png",
}));

vi.mock("date-fns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("date-fns")>();
  return {
    ...actual,
    formatDistanceToNow: () => "3 minutes ago",
  };
});

import { SuitesOverview } from "../suites-overview";

const idleActions = {
  onRerun: vi.fn(),
  onCancelRun: vi.fn(),
  rerunningSuiteId: null,
  cancellingRunId: null,
};

const suite = (over: Partial<EvalSuite> = {}): EvalSuite => ({
  _id: "suite-1",
  createdBy: "u1",
  name: "Excalidraw Draw Small House",
  description: "",
  configRevision: "1",
  environment: { servers: ["Excalidraw (App)"] },
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

const run = (over: Partial<EvalSuiteRun> = {}): EvalSuiteRun =>
  ({
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: Date.now() - 60_000,
    completedAt: Date.now() - 30_000,
    summary: { total: 3, passed: 2, failed: 1, passRate: 0.67 },
    ...over,
  }) as EvalSuiteRun;

const entry = (
  over: Partial<EvalSuiteOverviewEntry> = {},
): EvalSuiteOverviewEntry => ({
  suite: suite(),
  latestRun: run(),
  recentRuns: [],
  passRateTrend: [],
  totals: { passed: 2, failed: 1, runs: 1 },
  ...over,
});

describe("SuitesOverview", () => {
  it("renders suites as a User Testing-style list with client, server, and last run", () => {
    render(
      <SuitesOverview
        overview={[
          entry({
            suite: suite({
              hostAttachments: [
                {
                  namedHostId: "host-cursor",
                  enabledOptionalServerIds: [],
                  hostName: "Cursor",
                  resolvedServerNames: ["Excalidraw (App)"],
                },
              ],
            }),
          }),
        ]}
        onSelectSuite={vi.fn()}
        {...idleActions}
      />,
    );

    expect(screen.getByText("Suite")).toBeInTheDocument();
    expect(screen.getByText("Client")).toBeInTheDocument();
    expect(screen.getByText("Server")).toBeInTheDocument();
    expect(screen.getByText("Pass rate")).toBeInTheDocument();
    expect(screen.getByText("Last run")).toBeInTheDocument();

    expect(screen.getByText("Excalidraw Draw Small House")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("Excalidraw (App)")).toBeInTheDocument();
    expect(
      screen.getByTestId("evals-suites-overview-pass-rate"),
    ).toHaveTextContent("67%");
    expect(screen.getByText("3 minutes ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Excalidraw Draw Small House" })).toBeInTheDocument();
  });

  it("shows em dashes when a suite has no client, server, or runs yet", () => {
    render(
      <SuitesOverview
        overview={[
          entry({
            suite: suite({ environment: { servers: [] }, hostAttachments: [] }),
            latestRun: null,
          }),
        ]}
        onSelectSuite={vi.fn()}
        {...idleActions}
      />,
    );

    const row = screen.getByTestId("evals-suites-overview-row");
    expect(row).toHaveTextContent("—");
    expect(
      screen.getByTestId("evals-suites-overview-pass-rate"),
    ).toHaveTextContent("—");
  });

  it("shows the first client and a +N remainder when a suite has several hosts", () => {
    render(
      <SuitesOverview
        overview={[
          entry({
            suite: suite({
              hostAttachments: [
                {
                  namedHostId: "host-cursor",
                  enabledOptionalServerIds: [],
                  hostName: "Cursor",
                  resolvedServerNames: [],
                },
                {
                  namedHostId: "host-claude",
                  enabledOptionalServerIds: [],
                  hostName: "Claude",
                  resolvedServerNames: [],
                },
              ],
            }),
          }),
        ]}
        onSelectSuite={vi.fn()}
        {...idleActions}
      />,
    );

    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.queryByText("Claude")).toBeNull();
  });

  it("opens a suite when its row is clicked", () => {
    const onSelectSuite = vi.fn();
    render(
      <SuitesOverview
        overview={[entry()]}
        onSelectSuite={onSelectSuite}
        {...idleActions}
      />,
    );

    fireEvent.click(screen.getByTestId("evals-suites-overview-row"));
    expect(onSelectSuite).toHaveBeenCalledWith("suite-1");
  });

  it("runs the suite from the row action without opening it", () => {
    const onSelectSuite = vi.fn();
    const onRerun = vi.fn();
    const suiteWithServers = suite();
    render(
      <SuitesOverview
        overview={[entry({ suite: suiteWithServers })]}
        onSelectSuite={onSelectSuite}
        onRerun={onRerun}
        onCancelRun={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Run Excalidraw Draw Small House" }),
    );
    expect(onRerun).toHaveBeenCalledWith(suiteWithServers);
    expect(onSelectSuite).not.toHaveBeenCalled();
  });

  it("enables Run from host-attachment servers when environment.servers is empty", () => {
    const onRerun = vi.fn();
    const attachmentOnly = suite({
      environment: { servers: [] },
      hostAttachments: [
        {
          namedHostId: "host-cursor",
          enabledOptionalServerIds: [],
          hostName: "Cursor",
          resolvedServerNames: ["Excalidraw (App)"],
        },
      ],
    });
    render(
      <SuitesOverview
        overview={[entry({ suite: attachmentOnly })]}
        onSelectSuite={vi.fn()}
        onRerun={onRerun}
        onCancelRun={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Run Excalidraw Draw Small House" }),
    );
    expect(onRerun).toHaveBeenCalledWith(attachmentOnly);
  });

  it("disables Run when the suite has no effective servers", () => {
    const onRerun = vi.fn();
    render(
      <SuitesOverview
        overview={[
          entry({
            suite: suite({ environment: { servers: [] }, hostAttachments: [] }),
          }),
        ]}
        onSelectSuite={vi.fn()}
        onRerun={onRerun}
        onCancelRun={vi.fn()}
      />,
    );

    const runButton = screen.getByRole("button", {
      name: "No servers configured",
    });
    expect(runButton).toBeDisabled();
    expect(runButton).toHaveAttribute("title", "No servers configured");
    fireEvent.click(runButton);
    expect(onRerun).not.toHaveBeenCalled();
  });

  it("shows Cancel while a run is in progress and does not open the suite", () => {
    const onSelectSuite = vi.fn();
    const onCancelRun = vi.fn();
    render(
      <SuitesOverview
        overview={[
          entry({
            latestRun: run({ status: "running", completedAt: undefined }),
          }),
        ]}
        onSelectSuite={onSelectSuite}
        onRerun={vi.fn()}
        onCancelRun={onCancelRun}
      />,
    );

    expect(screen.queryByTestId("evals-suites-overview-run")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancel run for Excalidraw Draw Small House",
      }),
    );
    expect(onCancelRun).toHaveBeenCalledWith("run-1");
    expect(onSelectSuite).not.toHaveBeenCalled();
  });

  it("shows a spinning Running control while the suite is starting", () => {
    render(
      <SuitesOverview
        overview={[entry()]}
        onSelectSuite={vi.fn()}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        rerunningSuiteId="suite-1"
      />,
    );

    expect(screen.queryByTestId("evals-suites-overview-run")).toBeNull();
    expect(screen.queryByTestId("evals-suites-overview-cancel")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Running Excalidraw Draw Small House" }),
    ).toBeDisabled();
  });
});
