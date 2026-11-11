import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { EvaluateRunPage } from "../evaluate-run-page";
import {
  EvaluateHistoryHeader,
  EvaluateHistoryRow,
} from "../evaluate-history-row";
import type { ProjectRunRow } from "../../evals/project-runs-table";
import type { EvalRunAccount, EvalSuiteRun } from "../../evals/types";

const state = vi.hoisted(() => ({ flag: true }));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "eval-account-selection-enabled" ? state.flag : false,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
// The header's server groups beside the accounts read Convex themselves.
vi.mock("../run-server-groups", () => ({ RunServerGroups: () => null }));
vi.mock("@/hooks/useProjects", () => ({
  shouldQueryProjectId: () => true,
  useProjectServers: () => ({
    servers: [
      {
        _id: "srv-asana",
        projectId: "project",
        name: "Asana",
        enabled: true,
        transportType: "http",
      },
      {
        _id: "srv-linear",
        projectId: "project",
        name: "Linear",
        enabled: true,
        transportType: "http",
      },
    ],
  }),
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

const dummy: EvalRunAccount = {
  serverId: "srv-asana",
  kind: "account",
  connectionId: "conn-dummy",
  name: "Dummy",
};

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    projectId: "project",
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 43,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_010_000,
    source: "schedule",
    accountsAtRun: [dummy],
    ranAsName: "Sophie Lin",
    ...overrides,
  };
}

function renderPage(run: EvalSuiteRun) {
  return render(
    <EvaluateRunPage
      run={run}
      hostNamesById={new Map()}
      otherRuns={[]}
      defaultCompareRunId={null}
      onCompareWithRun={vi.fn()}
    >
      body
    </EvaluateRunPage>,
  );
}

beforeEach(() => {
  state.flag = true;
});

describe("the run header's account facts", () => {
  it("says a scheduled run ran as the schedule's owner, with its accounts", () => {
    renderPage(makeRun());
    const facts = screen.getByTestId("evaluate-run-account-facts");
    expect(within(facts).getByText("Ran as")).toBeInTheDocument();
    expect(facts).toHaveTextContent("Ran asSophie Lin Schedule owner");
    expect(facts).toHaveTextContent("AccountsAsana Dummy");
  });

  it("tags an API or CLI run with the key's owner, and a run from the app with nothing", () => {
    const { unmount } = renderPage(makeRun({ source: "api" }));
    expect(screen.getByTestId("evaluate-run-account-facts")).toHaveTextContent(
      "Key owner",
    );
    unmount();
    renderPage(makeRun({ source: "ui" }));
    const facts = screen.getByTestId("evaluate-run-account-facts");
    expect(facts).not.toHaveTextContent("Key owner");
    expect(facts).not.toHaveTextContent("Schedule owner");
  });

  it("lists every server's accounts", () => {
    renderPage(
      makeRun({
        accountsAtRun: [
          dummy,
          { ...dummy, connectionId: "conn-live", name: "Live" },
          { serverId: "srv-linear", kind: "shared", name: "Shared" },
        ],
      }),
    );
    expect(screen.getByTestId("evaluate-run-account-facts")).toHaveTextContent(
      "AccountsAsana Dummy, Live · Linear Shared",
    );
  });

  it("keeps an older run's header as it was", () => {
    renderPage(makeRun({ accountsAtRun: undefined, ranAsName: undefined }));
    expect(screen.queryByTestId("evaluate-run-account-facts")).toBeNull();
  });

  it("shows nothing while the rollout flag is off", () => {
    state.flag = false;
    renderPage(makeRun());
    expect(screen.queryByTestId("evaluate-run-account-facts")).toBeNull();
  });
});

describe("the Recent runs account columns", () => {
  const row = (overrides: Partial<ProjectRunRow> = {}): ProjectRunRow => ({
    _id: "run-1",
    suiteId: "suite-1",
    suiteName: "Asana task triage",
    runNumber: 43,
    status: "completed",
    result: "passed",
    source: "schedule",
    suiteSource: "ui",
    createdAt: 1000,
    completedAt: 3000,
    durationMs: 2000,
    createdBy: "u1",
    createdByName: null,
    createdByImageUrl: null,
    ciMetadata: null,
    summary: { passed: 1, failed: 0, total: 1, passRate: 100 },
    ...overrides,
  });

  function renderTable(run: EvalSuiteRun, showAccounts: boolean) {
    return render(
      <table>
        <EvaluateHistoryHeader showAccounts={showAccounts} />
        <tbody>
          <EvaluateHistoryRow
            rows={[row({ _id: run._id })]}
            details={new Map([[run._id, { run, iterations: [] }]])}
            historyRows={new Map()}
            showAccounts={showAccounts}
          />
        </tbody>
      </table>,
    );
  }

  it("adds Ran as and Accounts when the suite's runs recorded them", () => {
    renderTable(makeRun(), true);
    const headers = screen
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual(
      expect.arrayContaining(["Platform", "Ran as", "Accounts", "Commit"]),
    );
    expect(headers.indexOf("Ran as")).toBe(headers.indexOf("Platform") + 1);
    expect(screen.getByTestId("run-history-ran-as")).toHaveTextContent(
      "Sophie Lin Schedule owner",
    );
    expect(screen.getByTestId("run-history-accounts")).toHaveTextContent(
      "Asana Dummy",
    );
  });

  it("fills an older run's cells with a dash", () => {
    renderTable(makeRun({ accountsAtRun: undefined, ranAsName: undefined }), true);
    const cells = screen.getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells.filter((text) => text === "—").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTestId("run-history-accounts")).toBeNull();
  });

  it("leaves the columns out otherwise", () => {
    renderTable(makeRun(), false);
    expect(screen.queryByRole("columnheader", { name: "Ran as" })).toBeNull();
    expect(screen.queryByTestId("run-history-ran-as")).toBeNull();
  });
});
