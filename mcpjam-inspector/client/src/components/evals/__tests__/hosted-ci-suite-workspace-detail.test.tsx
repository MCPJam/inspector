import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { HostedCiSuiteWorkspaceDetail } from "../hosted-ci-suite-workspace-detail";
import type { EvalSuite } from "../types";

vi.mock("../suite-iterations-view", () => ({
  SuiteIterationsView: () => <div data-testid="suite-iterations-mock" />,
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

describe("HostedCiSuiteWorkspaceDetail", () => {
  it("does not render the Cases sidebar; main workspace uses SuiteIterationsView only", () => {
    const { container } = renderWithProviders(
      <HostedCiSuiteWorkspaceDetail
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
  });
});
