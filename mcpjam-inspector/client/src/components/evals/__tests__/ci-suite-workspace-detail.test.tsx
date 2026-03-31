import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { CiSuiteWorkspaceDetail } from "../ci-suite-workspace-detail";
import type { EvalSuite } from "../types";

vi.mock("../suite-iterations-view", () => ({
  SuiteIterationsView: (props: {
    readOnlyConfig?: boolean;
    caseListInSidebar?: boolean;
    omitRunIterationList?: boolean;
    omitSuiteHeader?: boolean;
  }) => (
    <div
      data-testid="suite-iterations-mock"
      data-read-only={String(!!props.readOnlyConfig)}
      data-case-list-in-sidebar={String(!!props.caseListInSidebar)}
      data-omit-run-iteration-list={String(!!props.omitRunIterationList)}
      data-omit-suite-header={String(!!props.omitSuiteHeader)}
    />
  ),
}));

const suite: EvalSuite = {
  _id: "suite-1",
  createdBy: "user-1",
  name: "Suite",
  description: "",
  configRevision: "1",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
};

const noopSuite = (_s: EvalSuite) => {};
const noopRun = (_id: string) => {};
const noopDelRun = (_id: string) => {};
const noopDirectDelRun = async () => {};

const baseProps = {
  suite,
  cases: [] as [],
  iterations: [] as [],
  allIterations: [] as [],
  runs: [] as [],
  runsLoading: false,
  aggregate: null as null,
  connectedServerNames: new Set<string>(),
  availableModels: [] as [],
  onRerun: noopSuite,
  onCancelRun: noopRun,
  onDelete: noopSuite,
  onDeleteRun: noopDelRun,
  onDirectDeleteRun: noopDirectDelRun,
  rerunningSuiteId: null as null,
  replayingRunId: null as null,
  cancellingRunId: null as null,
  deletingSuiteId: null as null,
  deletingRunId: null as null,
};

describe("CiSuiteWorkspaceDetail", () => {
  it("renders SuiteIterationsView without caseListInSidebar (suite list stays in CiEvalsTab)", () => {
    const { container } = renderWithProviders(
      <CiSuiteWorkspaceDetail
        {...baseProps}
        route={{
          type: "suite-overview",
          suiteId: suite._id,
          view: "runs",
        }}
      />,
    );

    expect(container.querySelectorAll("[data-panel]")).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Cases" })).toBeNull();
    expect(screen.getByTestId("suite-iterations-mock")).toBeInTheDocument();
    expect(screen.getByTestId("suite-iterations-mock")).toHaveAttribute(
      "data-case-list-in-sidebar",
      "false",
    );
    expect(screen.getByTestId("suite-iterations-mock")).toHaveAttribute(
      "data-omit-run-iteration-list",
      "false",
    );
    expect(screen.getByTestId("suite-iterations-mock")).toHaveAttribute(
      "data-omit-suite-header",
      "true",
    );
  });

  it("passes omitRunIterationList when route is run-detail (CI iteration list in sidebar)", () => {
    renderWithProviders(
      <CiSuiteWorkspaceDetail
        {...baseProps}
        route={{
          type: "run-detail",
          suiteId: suite._id,
          runId: "run-1",
        }}
        omitRunIterationList
      />,
    );

    expect(screen.getByTestId("suite-iterations-mock")).toHaveAttribute(
      "data-omit-run-iteration-list",
      "true",
    );
  });

  it("passes readOnlyConfig through to SuiteIterationsView", () => {
    renderWithProviders(
      <CiSuiteWorkspaceDetail
        {...baseProps}
        readOnlyConfig
        route={{
          type: "suite-overview",
          suiteId: suite._id,
          view: "runs",
        }}
      />,
    );

    expect(screen.getByTestId("suite-iterations-mock")).toHaveAttribute(
      "data-read-only",
      "true",
    );
  });

  it("defaults readOnlyConfig to true for SuiteIterationsView (CI has no config overrides)", () => {
    renderWithProviders(
      <CiSuiteWorkspaceDetail
        {...baseProps}
        route={{
          type: "suite-overview",
          suiteId: suite._id,
          view: "runs",
        }}
      />,
    );

    expect(screen.getByTestId("suite-iterations-mock")).toHaveAttribute(
      "data-read-only",
      "true",
    );
  });
});
