import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvalsSuiteListSidebar } from "../evals-suite-list-sidebar";
import type { EvalSuiteOverviewEntry, EvalSuiteRun } from "../types";

function makeRun(
  overrides: Partial<EvalSuiteRun> = {},
): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "s1",
    createdBy: "u",
    runNumber: 1,
    configRevision: "r",
    configSnapshot: {
      tests: [],
      environment: { servers: [] },
    },
    status: "completed",
    result: "failed",
    summary: {
      total: 10,
      passed: 4,
      failed: 6,
      passRate: 0.4,
    },
    createdAt: Date.now() - 3_600_000,
    completedAt: Date.now() - 3_600_000,
    ...overrides,
  };
}

function makeEntry(
  overrides: Partial<EvalSuiteOverviewEntry> & {
    suite: EvalSuiteOverviewEntry["suite"];
  },
): EvalSuiteOverviewEntry {
  return {
    latestRun: null,
    recentRuns: [],
    passRateTrend: [],
    totals: { passed: 0, failed: 0, runs: 0 },
    ...overrides,
  };
}

async function openSuiteFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Suite filters" }));
}

describe("EvalsSuiteListSidebar", () => {
  it("renders suite rows with last-run status", () => {
    const onSelectSuite = vi.fn();
    render(
      <EvalsSuiteListSidebar
        suites={[
          makeEntry({
            suite: {
              _id: "s1",
              createdBy: "u",
              name: "Alpha suite",
              description: "",
              configRevision: "r",
              environment: { servers: ["srv"] },
              createdAt: 1,
              updatedAt: 1,
              source: "ui",
              tags: [],
            },
          }),
        ]}
        selectedSuiteId={null}
        onSelectSuite={onSelectSuite}
        onCreateSuite={vi.fn()}
      />,
    );

    expect(screen.getByText("Alpha suite")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("suite-row-s1")).getAllByText("—"),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("checkbox", { name: "Select all suites" }),
    ).not.toBeInTheDocument();
  });

  it("opens suite edit from the row edit control", async () => {
    const user = userEvent.setup();
    const onEditSuite = vi.fn();
    render(
      <EvalsSuiteListSidebar
        suites={[
          makeEntry({
            suite: {
              _id: "s1",
              createdBy: "u",
              name: "Alpha suite",
              description: "",
              configRevision: "r",
              environment: { servers: ["srv"] },
              createdAt: 1,
              updatedAt: 1,
              source: "ui",
              tags: [],
            },
          }),
        ]}
        selectedSuiteId={null}
        onSelectSuite={vi.fn()}
        onCreateSuite={vi.fn()}
        onEditSuite={onEditSuite}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit suite: Alpha suite" }),
    );
    expect(onEditSuite).toHaveBeenCalledWith("s1");
  });

  it("shows batch selection when batch delete is enabled", () => {
    render(
      <EvalsSuiteListSidebar
        suites={[
          makeEntry({
            suite: {
              _id: "s1",
              createdBy: "u",
              name: "Alpha suite",
              description: "",
              configRevision: "r",
              environment: { servers: ["srv"] },
              createdAt: 1,
              updatedAt: 1,
              source: "ui",
              tags: [],
            },
          }),
        ]}
        selectedSuiteId={null}
        onSelectSuite={vi.fn()}
        onCreateSuite={vi.fn()}
        canDeleteSuites
        onDeleteSuitesBatch={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("checkbox", { name: "Select all suites" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select suite Alpha suite" }),
    ).toBeInTheDocument();
  });

  it("opens a suite from the play control when onRunAll is not provided", async () => {
    const user = userEvent.setup();
    const onSelectSuite = vi.fn();

    render(
      <EvalsSuiteListSidebar
        suites={[
          makeEntry({
            suite: {
              _id: "s1",
              createdBy: "u",
              name: "Beta",
              description: "",
              configRevision: "r",
              environment: { servers: [] },
              createdAt: 1,
              updatedAt: 1,
              source: "ui",
              tags: [],
            },
          }),
        ]}
        selectedSuiteId={null}
        onSelectSuite={onSelectSuite}
        onCreateSuite={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Open suite: Beta" }),
    );
    expect(onSelectSuite).toHaveBeenCalledWith("s1");
  });

  it("runs all cases from the play control when onRunAll is provided", async () => {
    const user = userEvent.setup();
    const onSelectSuite = vi.fn();
    const onRunAll = vi.fn();
    const suite = {
      _id: "s1",
      createdBy: "u",
      name: "Beta",
      description: "",
      configRevision: "r",
      environment: { servers: ["srv"] },
      createdAt: 1,
      updatedAt: 1,
      source: "ui" as const,
      tags: [],
    };

    render(
      <EvalsSuiteListSidebar
        suites={[makeEntry({ suite })]}
        selectedSuiteId={null}
        onSelectSuite={onSelectSuite}
        onCreateSuite={vi.fn()}
        onRunAll={onRunAll}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Run all cases in Beta" }),
    );
    expect(onRunAll).toHaveBeenCalledWith(suite);
    expect(onSelectSuite).not.toHaveBeenCalled();
  });

  it("disables run-all play controls while any suite rerun is in progress", () => {
    const suite = {
      _id: "s1",
      createdBy: "u",
      name: "Beta",
      description: "",
      configRevision: "r",
      environment: { servers: ["srv"] },
      createdAt: 1,
      updatedAt: 1,
      source: "ui" as const,
      tags: [],
    };

    render(
      <EvalsSuiteListSidebar
        suites={[makeEntry({ suite })]}
        selectedSuiteId={null}
        onSelectSuite={vi.fn()}
        onCreateSuite={vi.fn()}
        onRunAll={vi.fn()}
        rerunningSuiteId="other"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Run all cases in Beta" }),
    ).toBeDisabled();
  });

  it("disables run-all play controls while that suite's latest run is running", () => {
    const suite = {
      _id: "s1",
      createdBy: "u",
      name: "Beta",
      description: "",
      configRevision: "r",
      environment: { servers: ["srv"] },
      createdAt: 1,
      updatedAt: 1,
      source: "ui" as const,
      tags: [],
    };

    render(
      <EvalsSuiteListSidebar
        suites={[
          makeEntry({
            suite,
            latestRun: makeRun({
              status: "running",
              completedAt: undefined,
            }),
          }),
        ]}
        selectedSuiteId={null}
        onSelectSuite={vi.fn()}
        onCreateSuite={vi.fn()}
        onRunAll={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Run all cases in Beta" }),
    ).toBeDisabled();
  });

  it("renders pass/fail score for suites with run data", () => {
    render(
      <EvalsSuiteListSidebar
        suites={[
          makeEntry({
            suite: {
              _id: "s1",
              createdBy: "u",
              name: "Amazon Store",
              description: "",
              configRevision: "r",
              environment: { servers: ["amazon-mcp"] },
              createdAt: 1,
              updatedAt: 1,
              source: "sdk",
              tags: ["checkout"],
            },
            latestRun: makeRun(),
            passRateTrend: [0.3, 0.35, 0.4],
            totals: { passed: 4, failed: 6, runs: 12 },
          }),
        ]}
        selectedSuiteId={null}
        onSelectSuite={vi.fn()}
        onCreateSuite={vi.fn()}
      />,
    );

    const row = screen.getByTestId("suite-row-s1");
    expect(within(row).getByText("4/10")).toBeInTheDocument();
    expect(within(row).getByText("SDK")).toBeInTheDocument();
  });

  it("filters suites with failures-only toggle", async () => {
    const user = userEvent.setup();
    render(
      <EvalsSuiteListSidebar
        suites={[
          makeEntry({
            suite: {
              _id: "failed",
              createdBy: "u",
              name: "Failed Suite",
              description: "",
              configRevision: "r",
              environment: { servers: [] },
              createdAt: 1,
              updatedAt: 1,
              source: "ui",
              tags: [],
            },
            latestRun: makeRun({ result: "failed" }),
          }),
          makeEntry({
            suite: {
              _id: "passed",
              createdBy: "u",
              name: "Passed Suite",
              description: "",
              configRevision: "r",
              environment: { servers: [] },
              createdAt: 1,
              updatedAt: 1,
              source: "ui",
              tags: [],
            },
            latestRun: makeRun({
              result: "passed",
              summary: {
                total: 5,
                passed: 5,
                failed: 0,
                passRate: 1,
              },
            }),
          }),
        ]}
        selectedSuiteId={null}
        onSelectSuite={vi.fn()}
        onCreateSuite={vi.fn()}
      />,
    );

    expect(screen.getByText("Failed Suite")).toBeInTheDocument();
    expect(screen.getByText("Passed Suite")).toBeInTheDocument();

    await openSuiteFilters(user);
    await user.click(screen.getByRole("checkbox", { name: "Failures only" }));

    expect(screen.getByText("Failed Suite")).toBeInTheDocument();
    expect(screen.queryByText("Passed Suite")).not.toBeInTheDocument();
  });

  it("filters suites by search and tag", async () => {
    const user = userEvent.setup();
    render(
      <EvalsSuiteListSidebar
        suites={[
          makeEntry({
            suite: {
              _id: "s1",
              createdBy: "u",
              name: "Amazon Store",
              description: "",
              configRevision: "r",
              environment: { servers: [] },
              createdAt: 1,
              updatedAt: 1,
              source: "ui",
              tags: ["checkout"],
            },
          }),
          makeEntry({
            suite: {
              _id: "s2",
              createdBy: "u",
              name: "Excalidraw Diagramming",
              description: "",
              configRevision: "r",
              environment: { servers: [] },
              createdAt: 1,
              updatedAt: 1,
              source: "ui",
              tags: ["diagram"],
            },
          }),
        ]}
        selectedSuiteId={null}
        onSelectSuite={vi.fn()}
        onCreateSuite={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("searchbox", { name: "Search suites" }), "Amazon");
    expect(screen.getByText("Amazon Store")).toBeInTheDocument();
    expect(screen.queryByText("Excalidraw Diagramming")).not.toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "Search suites" }));
    await openSuiteFilters(user);
    await user.click(screen.getByRole("combobox", { name: "Filter by tag" }));
    await user.click(screen.getByRole("option", { name: "diagram" }));
    expect(screen.getByText("Excalidraw Diagramming")).toBeInTheDocument();
    expect(screen.queryByText("Amazon Store")).not.toBeInTheDocument();
  });

  it("sorts failed suites first by default", () => {
    render(
      <EvalsSuiteListSidebar
        suites={[
          makeEntry({
            suite: {
              _id: "passed",
              createdBy: "u",
              name: "Passed Suite",
              description: "",
              configRevision: "r",
              environment: { servers: [] },
              createdAt: 1,
              updatedAt: 1,
              source: "ui",
              tags: [],
            },
            latestRun: makeRun({
              result: "passed",
              summary: {
                total: 5,
                passed: 5,
                failed: 0,
                passRate: 1,
              },
            }),
          }),
          makeEntry({
            suite: {
              _id: "failed",
              createdBy: "u",
              name: "Failed Suite",
              description: "",
              configRevision: "r",
              environment: { servers: [] },
              createdAt: 1,
              updatedAt: 1,
              source: "ui",
              tags: [],
            },
            latestRun: makeRun({ result: "failed" }),
          }),
        ]}
        selectedSuiteId={null}
        onSelectSuite={vi.fn()}
        onCreateSuite={vi.fn()}
      />,
    );

    const rows = screen.getAllByTestId(/^suite-row-/);
    expect(rows[0]).toHaveAttribute("data-testid", "suite-row-failed");
    expect(within(rows[0]).getByText("Failed Suite")).toBeInTheDocument();
  });

  it("shows empty state when filters match no suites", async () => {
    const user = userEvent.setup();
    render(
      <EvalsSuiteListSidebar
        suites={[
          makeEntry({
            suite: {
              _id: "s1",
              createdBy: "u",
              name: "Amazon Store",
              description: "",
              configRevision: "r",
              environment: { servers: [] },
              createdAt: 1,
              updatedAt: 1,
              source: "ui",
              tags: [],
            },
            latestRun: makeRun({ result: "passed" }),
          }),
        ]}
        selectedSuiteId={null}
        onSelectSuite={vi.fn()}
        onCreateSuite={vi.fn()}
      />,
    );

    await openSuiteFilters(user);
    await user.click(screen.getByRole("checkbox", { name: "Failures only" }));
    expect(
      screen.getByText("No suites match your filters"),
    ).toBeInTheDocument();
  });
});
