import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvalsSuiteListSidebar } from "../evals-suite-list-sidebar";
import type { EvalSuiteOverviewEntry } from "../types";

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

    expect(screen.getByText("Browse and open suites")).toBeInTheDocument();
    expect(screen.getByText("Alpha suite")).toBeInTheDocument();
    expect(screen.getByText("Never run")).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "Select all suites" }),
    ).not.toBeInTheDocument();
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
});
