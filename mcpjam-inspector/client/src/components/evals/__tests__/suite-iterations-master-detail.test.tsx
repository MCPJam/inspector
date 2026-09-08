import { beforeEach, describe, it, expect, vi } from "vitest";
import { withDataRouter } from "./settings-sheet-harness";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuiteIterationsView } from "../suite-iterations-view";
import type { EvalSuite } from "../types";

const mocks = vi.hoisted(() => ({
  useMutation: vi.fn(() => vi.fn()),
  useQuery: vi.fn(),
  suiteHeader: vi.fn(),
  runOverview: vi.fn(),
}));

const cloudState = vi.hoisted(() => ({
  ephemeralAvailable: true as boolean | undefined,
  environments: [] as Array<{
    environmentId: string;
    computerEnvironmentId?: string;
  }>,
}));
vi.mock("@/hooks/useProjectComputer", () => ({
  useEphemeralCloudAvailable: () => cloudState.ephemeralAvailable,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => cloudState.environments,
}));

vi.mock("convex/react", () => ({
  useMutation: (name: any) => (mocks.useMutation as any)(name),
  useQuery: (name: any, args: any) => (mocks.useQuery as any)(name, args),
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));

// S3 — the settings sheet reads per-suite capabilities. `unavailable` is the
// pre-capabilities behaviour, which is what every assertion in this file was
// written against; a real read here would also need `useConvex` on the mock
// above, which this file deliberately does not provide.
// Overridable per test: the CI-owned lock reads BOTH the suite row and this,
// and the case they disagree is the one worth pinning.
const capabilitiesResult = vi.hoisted(() => ({
  current: { state: "unavailable", capabilities: null } as {
    state: string;
    capabilities: unknown;
  },
}));

vi.mock("@/hooks/use-suite-capabilities", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/use-suite-capabilities")
  >();
  return {
    ...actual,
    // RESPECTS ITS ARGUMENT, or it cannot prove anything about gating: a mock
    // that answers `ready` for every call passes on a surface where the real
    // hook is handed `null` and answers `unavailable`.
    useSuiteCapabilities: (suiteId: string | null) =>
      suiteId
        ? capabilitiesResult.current
        : { state: "unavailable", capabilities: null },
  };
});

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null, isLoading: false, signIn: vi.fn() }),
}));

// `SuiteDetailOverview` (Evaluate (New)) reads this; the shipped tab's
// dashboard does not, so it is only exercised by the opt-in block below.
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

vi.mock("../use-suite-data", () => ({
  useSuiteData: () => ({
    runTrendData: [],
    modelStats: [],
  }),
  useRunDetailData: () => ({
    caseGroupsForSelectedRun: [],
  }),
}));

vi.mock("../suite-header", () => ({
  SuiteHeader: (props: any) => {
    mocks.suiteHeader(props);
    return (
      <div data-testid="suite-header">{props.overviewModeSelector}</div>
    );
  },
}));

vi.mock("../eval-export-modal", () => ({
  EvalExportModal: () => null,
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
}));

vi.mock("../run-overview", () => ({
  RunOverview: (props: unknown) => {
    mocks.runOverview(props);
    return <div data-testid="run-overview" />;
  },
}));

vi.mock("../suite-hero-stats", () => ({
  SuiteHeroStats: () => <div data-testid="suite-hero-stats" />,
}));

vi.mock("../suite-dashboard", () => ({
  SuiteDashboard: ({
    onTestCaseClick,
    onOpenLastRun,
    selectedRunId,
  }: {
    onTestCaseClick: (testCaseId: string) => void;
    onOpenLastRun?: (testCaseId: string, iterationId: string) => void;
    selectedRunId?: string | null;
  }) => (
    <div data-testid="suite-dashboard">
      All runs latest + trends per client
      {selectedRunId ? null : (
        <>
          <button
            type="button"
            data-testid="test-cases-overview"
            onClick={() => onTestCaseClick("case-1")}
          >
            Click on a case to view its run history and performance.
          </button>
          <button
            type="button"
            data-testid="test-cases-open-last-run"
            onClick={() => onOpenLastRun?.("case-1", "iter-1")}
          >
            Open last run
          </button>
        </>
      )}
    </div>
  ),
}));

vi.mock("../run-detail-view", () => ({
  RunDetailView: () => <div data-testid="run-detail-view" />,
}));

vi.mock("../test-cases-overview", () => ({
  TestCasesOverview: ({
    onTestCaseClick,
    onOpenLastRun,
  }: {
    onTestCaseClick: (testCaseId: string) => void;
    onOpenLastRun?: (testCaseId: string, iterationId: string) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="test-cases-overview"
        onClick={() => onTestCaseClick("case-1")}
      >
        Click on a case to view its run history and performance.
      </button>
      <button
        type="button"
        data-testid="test-cases-open-last-run"
        onClick={() => onOpenLastRun?.("case-1", "iter-1")}
      >
        Open last run
      </button>
    </div>
  ),
}));

const noopNav = {
  toSuiteOverview: vi.fn(),
  toRunDetail: vi.fn(),
  toTestDetail: vi.fn(),
  toTestEdit: vi.fn(),
  toSuiteEdit: vi.fn(),
};

const baseSuite: EvalSuite = {
  _id: "suite-1",
  createdBy: "u",
  name: "Test Suite",
  description: "",
  configRevision: "r",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
};

describe("SuiteIterationsView caseListInSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMutation.mockReturnValue(vi.fn());
    mocks.useQuery.mockImplementation((_name: string, args: unknown) => {
      if (args === "skip") {
        return undefined;
      }
      return undefined;
    });
  });

  it("does not mount TestCasesOverview when case index is in the parent sidebar", () => {
    render(
      withDataRouter(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        canDeleteSuite={false}
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "test-cases",
        }}
        navigation={noopNav}
        caseListInSidebar
      />,)
    );

    expect(screen.queryByTestId("test-cases-overview")).toBeNull();
    expect(
      screen.getByText(/Select a case from the list on the left/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("suite-hero-stats")).toBeInTheDocument();
  });

  it("replaces run-oriented overview chrome when run actions are hidden", () => {
    render(
      withDataRouter(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        canDeleteSuite={false}
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "test-cases",
        }}
        navigation={noopNav}
        caseListInSidebar
        hideRunActions
      />,)
    );

    expect(screen.queryByTestId("suite-hero-stats")).toBeNull();
    expect(screen.getByText(/run it individually/i)).toBeInTheDocument();
  });

  it("still mounts TestCasesOverview without caseListInSidebar", () => {
    render(
      withDataRouter(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        canDeleteSuite={false}
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "test-cases",
        }}
        navigation={noopNav}
      />,)
    );

    expect(screen.getByTestId("test-cases-overview")).toBeInTheDocument();
  });

  it("opens test edit with compare deep link from the cases list when run actions are hidden", async () => {
    const user = userEvent.setup();
    const navigation = {
      ...noopNav,
      toTestEdit: vi.fn(),
    };

    render(
      withDataRouter(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[
          {
            _id: "case-1",
            testSuiteId: "suite-1",
            createdBy: "u",
            title: "Case 1",
            query: "Prompt",
            models: [],
            runs: 1,
            expectedToolCalls: [],
          },
        ]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        canDeleteSuite={false}
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "test-cases",
        }}
        navigation={navigation}
        hideRunActions
      />,)
    );

    await user.click(screen.getByTestId("test-cases-overview"));

    expect(navigation.toTestEdit).toHaveBeenCalledWith("suite-1", "case-1");
  });

  it("preserves the clicked iteration when opening compare from the cases list", async () => {
    const user = userEvent.setup();
    const navigation = {
      ...noopNav,
      toTestEdit: vi.fn(),
    };

    render(
      withDataRouter(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[
          {
            _id: "case-1",
            testSuiteId: "suite-1",
            createdBy: "u",
            title: "Case 1",
            query: "Prompt",
            models: [],
            runs: 1,
            expectedToolCalls: [],
          },
        ]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        canDeleteSuite={false}
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "test-cases",
        }}
        navigation={navigation}
        hideRunActions
      />,)
    );

    await user.click(screen.getByTestId("test-cases-open-last-run"));

    expect(navigation.toTestEdit).toHaveBeenCalledWith("suite-1", "case-1", {
      openCompare: true,
      iteration: "iter-1",
    });
  });

  it("passes canDeleteSuite through to RunOverview in read-only overview (runs view)", () => {
    render(
      withDataRouter(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        canDeleteSuite
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "runs",
        }}
        navigation={noopNav}
        readOnlyConfig
      />,)
    );

    expect(mocks.runOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        canDeleteSuite: true,
      }),
    );
  });
  /*
   * `suite.delete` IS in the backend's CI-locked set, so the trash on a
   * CI-owned suite is a button whose only outcome is a `409` — the exact
   * failure this change exists to replace, reached by the one verb that is
   * not spelled "edit".
   *
   * The prop answers by ROLE, and role is not the question: an org owner holds
   * `suite.delete` on a CI-owned suite and still cannot use it.
   *
   * Note the pairing with the test above: that one passes `readOnlyConfig` and
   * still expects `true`. The two are deliberately different — `readOnlyConfig`
   * is about editing configuration, and the platform refuses delete for
   * ownership, not for that. Wiring delete to `editingDisabled` would pass this
   * test and break that one, which is why both are here.
   */
  it("withholds suite delete from RunOverview when CI owns the suite", () => {
    render(
      withDataRouter(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        canDeleteSuite
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "runs",
        }}
        navigation={noopNav}
        configLocked
      />,)
    );

    expect(mocks.runOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        canDeleteSuite: false,
      })
    );
  })
  /*
   * THE ROW LOCKS THE SUITE WITHOUT ANY CALLER'S HELP.
   *
   * `CiEvalsTab` never passed `configLocked` — no prop, no import — so on the
   * CI Runs tab, the surface most likely to be SHOWING a CI-owned suite, the
   * row half of the lock was simply absent. The suite stayed fully editable
   * until `useSuiteCapabilities` resolved, and `capabilitiesResult` is
   * `unavailable` here, which is also what a backend predating the ownership
   * query answers forever.
   *
   * So: an SDK-ingested suite, NO `configLocked` prop, no capability answer.
   * It must still be locked, from the row alone.
   */
  it("locks from the suite row when no caller passes configLocked", () => {
    render(
      withDataRouter(
      <SuiteIterationsView
        suite={{ ...baseSuite, source: "sdk" }}
        cases={[]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        onCreateTestCase={vi.fn()}
        onGenerateTestCases={vi.fn()}
        connectedServerNames={new Set()}
        canDeleteSuite
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "runs",
        }}
        navigation={noopNav}
      />,)
    );

    // `RunOverview` takes no `configLocked` — every control it renders runs or
    // stops a run, none edits — so the lock shows up here as the withdrawn
    // delete, and on the header as the withheld case authoring.
    expect(mocks.runOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        canDeleteSuite: false,
      })
    );

    const header = mocks.suiteHeader.mock.calls.at(-1)?.[0];
    expect(header.configLocked).toBe(true);
    expect(header.onCreateTestCase).toBeUndefined();
    expect(header.onGenerateTestCases).toBeUndefined();
    // Running is untouched: the lock is on edits, not on the suite.
    expect(header.onRerun).toBeTypeOf("function");
  });
});

describe("SuiteIterationsView cloud-sandbox gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloudState.ephemeralAvailable = true;
    cloudState.environments = [];
    mocks.useMutation.mockReturnValue(vi.fn());
    mocks.useQuery.mockReturnValue(undefined);
  });

  function renderView(suite: EvalSuite, projectId?: string) {
    render(
      withDataRouter(
      <SuiteIterationsView
        suite={suite}
        {...(projectId ? { projectId } : {})}
        cases={[]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        canDeleteSuite={false}
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "test-cases",
        }}
        navigation={noopNav}
      />,)
    );
  }

  it("folds the preflight into the reason handed to EVERY run control", () => {
    // The parent derives the gate exactly once; the header (and the per-case
    // dashboards, which read the same shadowed variable) receive it as the
    // ordinary disabled-reason prop.
    cloudState.ephemeralAvailable = false;
    renderView({
      ...baseSuite,
      environment: { servers: [], computerEnvironmentId: "img-1" },
    });
    expect(mocks.suiteHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        evalRunsDisabledReason: expect.stringMatching(
          /can't run MCPJam cloud sandboxes/,
        ),
      }),
    );
  });

  it("catches a pin carried by an ATTACHED environment", () => {
    cloudState.ephemeralAvailable = false;
    cloudState.environments = [
      { environmentId: "env-9", computerEnvironmentId: "img-9" },
    ];
    renderView({ ...baseSuite, environmentIds: ["env-9"] }, "proj-1");
    expect(mocks.suiteHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        evalRunsDisabledReason: expect.stringMatching(
          /can't run MCPJam cloud sandboxes/,
        ),
      }),
    );
  });

  it("passes no reason when the pinned suite CAN reach cloud sandboxes", () => {
    renderView({
      ...baseSuite,
      environment: { servers: [], computerEnvironmentId: "img-1" },
    });
    expect(mocks.suiteHeader).toHaveBeenCalledWith(
      expect.objectContaining({ evalRunsDisabledReason: null }),
    );
  });
});

/**
 * `suiteDetailOverview` is the one opt-in the shipped Evaluate tab does NOT
 * pass. These assert both halves of that: off is exactly the behaviour every
 * current caller has, on is the Evaluate (New) suite page.
 */
describe("SuiteIterationsView suiteDetailOverview", () => {
  const detailCase = {
    _id: "case-1",
    testSuiteId: "suite-1",
    createdBy: "u",
    title: "Case 1",
    query: "Prompt",
    models: [],
    runs: 1,
    expectedToolCalls: [],
  };

  const renderOverview = (
    props: Partial<Record<string, unknown>> = {},
    navigation = noopNav,
  ) =>
    render(
      withDataRouter(
      <SuiteIterationsView
        suite={{ ...baseSuite, name: "checkout-flow" }}
        cases={[detailCase as any]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        canDeleteSuite={false}
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "test-cases",
        }}
        navigation={navigation}
        hideRunActions
        {...(props as any)}
      />,)
    );

  it("keeps the unified dashboard when the flag-gated tab has not opted in", () => {
    renderOverview();

    expect(screen.queryByTestId("suite-detail-overview")).toBeNull();
    expect(screen.getByTestId("suite-header")).toBeInTheDocument();
  });

  it("passes case authoring through on the legacy dashboard for an app-authored suite", () => {
    // The guard against over-locking, and the reason the next test means
    // something: these callbacks reach the header to begin with.
    const onCreateTestCase = vi.fn();
    const onGenerateTestCases = vi.fn();
    renderOverview({ onCreateTestCase, onGenerateTestCases });

    const props = mocks.suiteHeader.mock.calls.at(-1)?.[0];
    expect(props.onCreateTestCase).toBe(onCreateTestCase);
    expect(props.onGenerateTestCases).toBe(onGenerateTestCases);
  });

  it("locks on the BACKEND's answer when the cached row still says otherwise", () => {
    // The row and the capability can disagree: the row is a cached document,
    // the capability is the predicate that will actually refuse the write. When
    // only the capability says CI owns this, everything has to move together —
    // an earlier revision locked the settings column off the combined answer
    // while the case callbacks and the CI-owned notice still read the row, so a
    // suite the backend calls CI's greyed out its settings, offered Add case
    // anyway, and explained nothing.
    capabilitiesResult.current = {
      state: "ready",
      capabilities: {
        suiteId: "suite-1",
        organizationId: "org-1",
        permissions: {},
        features: { computers: { enabled: true, reason: null } },
        verdictPolicyV2: {
          deploymentMode: "enforce",
          suiteMode: null,
          canUpgrade: false,
        },
        ownership: { ciOwned: true },
      },
    };
    try {
      renderOverview({
        configLocked: false,
        onCreateTestCase: vi.fn(),
        onGenerateTestCases: vi.fn(),
      });

      const props = mocks.suiteHeader.mock.calls.at(-1)?.[0];
      expect(props.configLocked).toBe(true);
      expect(props.onCreateTestCase).toBeUndefined();
      expect(props.onGenerateTestCases).toBeUndefined();
    } finally {
      capabilitiesResult.current = {
        state: "unavailable",
        capabilities: null,
      };
    }
  });

  /*
   * A CAPABILITY THAT ARRIVES WITHOUT `verdictPolicyV2` MUST NOT TAKE THE PAGE
   * DOWN.
   *
   * Every capability read in this component is optional except one, which
   * dereferenced `capabilities.verdictPolicyV2.canUpgrade` directly — so a
   * backend answering without that block threw during render.
   *
   * It matters more since this component started asking for capabilities on
   * EVERY suite view rather than only in edit mode: the same response now
   * breaks the page for anyone looking at a suite, not just someone editing
   * one. The hook's own contract is that a partial or failed answer costs
   * nothing.
   */
  it("survives a capabilities answer with no verdictPolicyV2 block", () => {
    capabilitiesResult.current = {
      state: "ready",
      capabilities: {
        suiteId: "suite-1",
        organizationId: "org-1",
        permissions: {},
        features: {},
        ownership: { ciOwned: false },
      },
    };
    try {
      renderOverview();
      expect(mocks.suiteHeader).toHaveBeenCalled();
    } finally {
      capabilitiesResult.current = {
        state: "unavailable",
        capabilities: null,
      };
    }
  });

  it("withholds case authoring on the legacy dashboard when CI owns the suite", () => {
    // The legacy Evals surface never renders `suite-detail-overview`, so a
    // lock that lived only on the opted-in overview missed it entirely — Add
    // case, Generate and batch delete stayed reachable on exactly the suite
    // the platform answers with `CI_OWNED_SUITE_READ_ONLY`.
    //
    // Asserted as WITHHELD CALLBACKS rather than as absent buttons: the
    // callbacks are dropped once, at the top of the view, so every consumer
    // below — header, dashboard, folded dashboard, sidebar case list, run
    // page — is covered by the same act, including the one added next.
    renderOverview({
      configLocked: true,
      onCreateTestCase: vi.fn(),
      onGenerateTestCases: vi.fn(),
      onRecordTestCase: vi.fn(),
      onDeleteTestCasesBatch: vi.fn(),
    });

    const props = mocks.suiteHeader.mock.calls.at(-1)?.[0];
    expect(props.onCreateTestCase).toBeUndefined();
    expect(props.onGenerateTestCases).toBeUndefined();
    expect(props.configLocked).toBe(true);
    // Running is NOT withheld: running a CI-owned suite from the app is the
    // whole point of locking edits rather than the suite.
    expect(props.onRerun).toBeTypeOf("function");
  });

  it("renders the Evaluate (New) suite-detail identity row when opted in", () => {
    renderOverview({ suiteDetailOverview: true });

    expect(screen.getByTestId("suite-detail-overview")).toBeInTheDocument();
    expect(screen.getByTestId("suite-detail-identity")).toHaveTextContent(
      "checkout-flow",
    );
    expect(screen.queryByTestId("suite-header")).toBeNull();
  });

  it("opens test edit from the opted-in suite-detail case list", async () => {
    const user = userEvent.setup();
    const navigation = { ...noopNav, toTestEdit: vi.fn() };

    renderOverview({ suiteDetailOverview: true }, navigation);

    await user.click(screen.getByTestId("suite-test-case-row-case-1"));

    expect(navigation.toTestEdit).toHaveBeenCalledWith("suite-1", "case-1");
  });

  it("keeps the suite header on the edit route so rename and Done stay reachable", () => {
    // `viewMode` falls through to "overview" for suite-edit, so the opt-in has
    // to exclude edit mode explicitly. SuiteHeader is the ONLY mount point for
    // the edit chrome (name editor + Done). The environment composer lives on
    // the settings sheet, not the overview header.
    renderOverview({
      suiteDetailOverview: true,
      route: { type: "suite-edit", suiteId: "suite-1" },
    });

    expect(screen.getByTestId("suite-header")).toBeInTheDocument();
    expect(screen.queryByTestId("suite-detail-overview")).toBeNull();
    expect(mocks.suiteHeader).toHaveBeenCalledWith(
      expect.objectContaining({ isEditMode: true }),
    );
  });

  const detailRun = {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "u",
    runNumber: 1,
    configRevision: "r",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed" as const,
    result: "failed" as const,
    createdAt: 2,
    completedAt: 3,
    source: "ui" as const,
  };

  const otherRun = {
    ...detailRun,
    _id: "run-0",
    createdAt: 1,
    completedAt: 2,
  };

  it("opens Evaluate (New) run page instead of the unified split", () => {
    renderOverview({
      suiteDetailOverview: true,
      runs: [detailRun, otherRun],
      route: {
        type: "run-detail",
        suiteId: "suite-1",
        runId: "run-1",
      },
    });

    expect(screen.getByTestId("evaluate-run-page")).toBeInTheDocument();
    expect(screen.getByTestId("run-detail-view")).toBeInTheDocument();
    expect(screen.queryByTestId("suite-dashboard")).toBeNull();
    expect(screen.queryByText(/All runs/i)).toBeNull();
    expect(screen.queryByTestId("suite-header")).toBeNull();
  });

  it("keeps the unified split on run-detail when the opt-in is off", () => {
    renderOverview({
      hideRunActions: true,
      runs: [detailRun, otherRun],
      route: {
        type: "run-detail",
        suiteId: "suite-1",
        runId: "run-1",
      },
    });

    expect(screen.getByTestId("suite-dashboard")).toBeInTheDocument();
    expect(screen.getByText(/All runs/i)).toBeInTheDocument();
    expect(screen.queryByTestId("evaluate-run-page")).toBeNull();
  });
});
