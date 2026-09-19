import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { SuiteHealth, buildSuiteHealth } from "../suite-health";
import type { ProjectRunRow } from "../../evals/project-runs-table";
import type { ProjectRunHistoryDetail } from "../../evals/use-project-run-history";

function fixture() {
  const rows = [
    {
      _id: "old",
      suiteId: "s1",
      suiteName: "Amazon",
      runNumber: 1,
      createdAt: 1,
      status: "completed",
    },
    {
      _id: "new",
      suiteId: "s1",
      suiteName: "Amazon",
      runNumber: 2,
      createdAt: 2,
      status: "completed",
    },
    {
      _id: "other",
      suiteId: "s2",
      suiteName: "Excalidraw",
      runNumber: 1,
      createdAt: 0,
      status: "completed",
    },
  ] as ProjectRunRow[];
  const details = new Map(
    rows.map((row, index) => [
      row._id,
      {
        run: {
          ...row,
          client: {
            source: "suite_default",
            name: "Claude",
            hostStyle: "claude",
          },
          passCriteria: { minimumPassRate: 80 },
        },
        iterations: Array.from({ length: index === 0 ? 1 : 3 }, (_, i) => ({
          _id: `${row._id}-${i}`,
          suiteRunId: row._id,
          status: "completed",
          result: index === 0 || i === 0 ? "passed" : "failed",
        })),
      } as ProjectRunHistoryDetail,
    ]),
  );
  return { rows, details };
}

describe("Suite Health", () => {
  it("opens the launch row's representative when charting a different client", async () => {
    const data = fixture();
    data.details.get("old")!.run.runGroupId = "shared-launch";
    data.details.get("new")!.run.runGroupId = "shared-launch";
    data.details.get("new")!.run.client = {
      source: "suite_default",
      name: "Cursor",
      hostStyle: "cursor",
    };
    const onSelectRun = vi.fn();
    render(
      <SuiteHealth
        {...data}
        complete
        failed={false}
        onRetry={vi.fn()}
        hostNamesById={new Map()}
        onSelectRun={onSelectRun}
      />,
    );
    // The newest client is Cursor, but both clients share row #1.
    const point = buildSuiteHealth(
      data.rows,
      data.details,
      "s1",
      "style:cursor",
    ).points[0];
    expect(point.runNumber).toBe(1);
    expect(point.rate).toBeCloseTo(100 / 3);
    await userEvent.setup().click(screen.getByTestId("suite-health-bar"));
    expect(onSelectRun).toHaveBeenCalledWith({ suiteId: "s1", runId: "old" });
  });

  it("uses the suite's current threshold, including zero", () => {
    render(
      <SuiteHealth
        {...fixture()}
        complete
        failed={false}
        onRetry={vi.fn()}
        hostNamesById={new Map()}
        suiteOverview={[
          {
            suite: { _id: "s1", defaultPassCriteria: { minimumPassRate: 0 } },
          } as any,
        ]}
      />,
    );
    expect(screen.getByTestId("suite-health-threshold")).toHaveStyle({
      bottom: "0%",
    });
  });

  it("groups model fanout into one bar per launch for the selected client", () => {
    const { rows, details } = fixture();
    details.get("old")!.run.runGroupId = "launch";
    details.get("new")!.run.runGroupId = "launch";
    const result = buildSuiteHealth(rows, details, "s1", "style:claude");
    expect(result.points).toHaveLength(1);
    expect(result.average).toBe(50);
  });
  it("changes clients and resets the client when selecting another suite", async () => {
    const data = fixture();
    data.details.get("old")!.run.client = {
      source: "suite_default",
      name: "ChatGPT",
      hostStyle: "chatgpt",
    };
    const user = userEvent.setup();
    render(
      <SuiteHealth
        {...data}
        complete
        failed={false}
        onRetry={vi.fn()}
        hostNamesById={new Map()}
      />,
    );
    expect(screen.getByTestId("suite-health-average")).toHaveTextContent("33%");
    await user.click(
      screen.getByRole("combobox", { name: "Suite Health client" }),
    );
    await user.click(screen.getByRole("option", { name: "ChatGPT" }));
    expect(screen.getByTestId("suite-health-average")).toHaveTextContent(
      "100%",
    );
    await user.click(
      screen.getByRole("combobox", { name: "Suite Health suite" }),
    );
    await user.click(screen.getByRole("option", { name: "Excalidraw" }));
    expect(screen.getByRole("heading", { name: "Excalidraw" })).toBeVisible();
    expect(screen.getByTestId("suite-health-average")).toHaveTextContent("33%");
  });
  it("averages per-run rates, not pooled iteration counts, and orders bars oldest first", () => {
    const { rows, details } = fixture();
    const result = buildSuiteHealth(rows, details, "s1", "style:claude");
    expect(result.points.map((point) => point.runNumber)).toEqual([1, 2]);
    expect(result.average).toBeCloseTo(66.6667);
    expect(result.threshold).toBe(80);
  });

  it("defaults to the newest run's suite and shows real rates and threshold", () => {
    render(
      <SuiteHealth
        {...fixture()}
        complete
        failed={false}
        onRetry={vi.fn()}
        hostNamesById={new Map()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Amazon" })).toBeVisible();
    expect(screen.getByTestId("suite-health-average")).toHaveTextContent("67%");
    expect(screen.getAllByTestId("suite-health-bar")).toHaveLength(2);
    expect(screen.getAllByTestId("suite-health-bar-date")).toHaveLength(2);
    expect(screen.getByTestId("suite-health-threshold")).toHaveStyle({
      bottom: "80%",
    });
    expect(
      screen.getByRole("combobox", { name: "Suite Health suite" }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "Suite Health client" }),
    ).toBeVisible();
  });

  it("withholds partial averages and offers retry on history errors", () => {
    const onRetry = vi.fn();
    render(
      <SuiteHealth
        {...fixture()}
        complete={false}
        failed
        onRetry={onRetry}
        hostNamesById={new Map()}
      />,
    );
    expect(screen.queryByTestId("suite-health-average")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("holds the card's full height while the history loads", () => {
    render(
      <SuiteHealth
        {...fixture()}
        complete={false}
        failed={false}
        onRetry={vi.fn()}
        hostNamesById={new Map()}
      />,
    );
    // No number at all until it is real — a skeleton cannot be misread as one.
    expect(screen.queryByTestId("suite-health-average")).toBeNull();
    const loading = screen.getByRole("status", {
      name: "Loading run history",
    });
    expect(
      loading.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    // The axis is the card's real one, so the chart does not resize on load.
    expect(loading).toHaveTextContent("100%");
    expect(loading).toHaveTextContent("0%");
  });

  it("excludes in-flight runs and does not invent empty results", () => {
    const { rows, details } = fixture();
    rows[0].status = "running";
    details.get("new")!.iterations = [];
    expect(
      buildSuiteHealth(rows, details, "s1", "style:claude").average,
    ).toBeNull();
  });
});
