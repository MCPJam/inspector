import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalIteration, EvalSuiteRun } from "../types";

// The envelope hook subscribes to Convex; these specs render without a
// provider, so it is stubbed exactly like the rail above. `undefined` is the
// real "still loading / no envelope" value, and the panel renders nothing for
// it — the mount is what these specs care about.
vi.mock(
  "@/components/shared/actionable-insights/use-insights-envelope",
  () => ({ useInsightsEnvelope: () => undefined }),
);

vi.mock("../use-run-insights", () => ({
  useRunInsights: vi.fn(),
}));

// The CANONICAL selected-run fetch. Mocked rather than driven through the
// `convex/react` stub below (which answers `undefined` to everything) so a
// test can hand the view a real frozen projection — the whole point of this
// hook is that the data does NOT come from the run object the view is passed.
vi.mock("../use-run-import-eligibility", () => ({
  useRunImportEligibility: vi.fn(() => ({
    eligibility: undefined,
    isLoading: false,
  })),
}));

vi.mock("../use-server-quality", () => ({
  useServerQuality: vi.fn(() => ({
    result: null,
    pending: false,
    requested: false,
    failedGeneration: false,
    error: null,
    requestServerQuality: vi.fn(),
    unavailable: true,
  })),
}));

// Stub the goal-completion judge hook so the rail stays empty in view tests
// that aren't about the judge panel. Matches the `unavailable: true` shape
// used for useServerQuality above so callers see no rendered card.
vi.mock("../use-groundedness", () => ({
  useGroundedness: vi.fn(() => ({
    result: null,
    pending: false,
    requested: false,
    failedGeneration: false,
    error: null,
    requestGroundedness: vi.fn(),
    // Same rule as the goal-completion mock below: this suite is about
    // layout, so the advisory judges stay unavailable unless a test says so.
    unavailable: true,
  })),
}));

vi.mock("../use-goal-completion", () => ({
  useGoalCompletion: vi.fn(() => ({
    result: null,
    pending: false,
    requested: false,
    failedGeneration: false,
    error: null,
    canRequest: false,
    requestGoalCompletion: vi.fn(),
    cancelGoalCompletion: vi.fn(),
    summary: null,
    unavailable: true,
  })),
}));

import { useRunInsights } from "../use-run-insights";
import { useRunImportEligibility } from "../use-run-import-eligibility";
import { RunDetailView, RunIterationsSidebar } from "../run-detail-view";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn().mockResolvedValue(undefined),
  useQuery: () => undefined,
  useAction: () => vi.fn().mockResolvedValue(undefined),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
}));

// The goal-completion judge panel pulls the model catalog; stub it so the view
// test stays isolated from the provider chain (auth / provider keys / ollama).
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => (
    <div data-testid="run-detail-resizable-group" className={className}>
      {children}
    </div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div data-testid="run-detail-resizable-panel">{children}</div>
  ),
  ResizableHandle: () => <div data-testid="run-detail-resizable-handle" />,
}));

// The panel derives the judge's org scope from shared app state.
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ projects: {}, activeProjectId: null }),
}));

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user",
    runNumber: 1,
    configRevision: "rev1",
    configSnapshot: {
      tests: [],
      environment: { servers: [] },
    },
    status: "completed",
    createdAt: 1,
    completedAt: 2,
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    ...overrides,
  };
}

function makeIteration(overrides: Partial<EvalIteration> = {}): EvalIteration {
  return {
    _id: "iter-1",
    createdBy: "user",
    createdAt: 1,
    iterationNumber: 1,
    updatedAt: 2,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 100,
    testCaseSnapshot: {
      title: "Test A",
      query: "q",
      provider: "openai",
      model: "gpt-4",
      expectedToolCalls: [],
    },
    ...overrides,
  };
}

function defaultRunInsightsReturn() {
  return {
    summary: null as string | null,
    pending: false,
    requested: false,
    failedGeneration: false,
    error: null as string | null,
    requestRunInsights: vi.fn(),
    cancelRunInsights: vi.fn(),
    unavailable: false,
    canRequest: true,
  };
}

describe("RunDetailView", () => {
  beforeEach(() => {
    vi.mocked(useRunInsights).mockReturnValue(defaultRunInsightsReturn());
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  /**
   * Frozen import evidence on a finished run.
   *
   * Two things are asserted that a screenshot would not catch: the data comes
   * from the CANONICAL single-run query (not from the list row the view is
   * handed), and incomplete evidence is described as NOT GATEABLE rather than
   * as a failure. A screen that blamed the server under test for a conversion
   * nobody finished reviewing would send people to debug the wrong thing.
   */
  describe("import evidence", () => {
    function renderRun() {
      return render(
        <RunDetailView
          selectedRunDetails={makeRun()}
          caseGroupsForSelectedRun={[makeIteration()]}
          source="ui"
          runDetailSortBy="test"
          onSortChange={() => {}}
          selectedIterationId={null}
          onSelectIteration={() => {}}
          omitIterationList
        />
      );
    }

    it("fetches the canonical eligibility for the run it is displaying", () => {
      renderRun();
      // The run object this view receives comes from the run LIST projection,
      // which carries no eligibility. Reading it off that object would render
      // every converted run as though it had no imported cases.
      expect(useRunImportEligibility).toHaveBeenCalledWith("run-1");
    });

    it("renders frozen approval receipts: who, when, why, and which case", () => {
      vi.mocked(useRunImportEligibility).mockReturnValue({
        eligibility: {
          status: "eligible",
          gateable: true,
          importedCaseCount: 2,
          claimedExactCaseIds: ["case_1"],
          approvedApproximationCaseIds: ["case_2"],
          approvedApproximationReceipts: [
            {
              testCaseId: "case_2",
              caseKey: "ui_refund_partial",
              sourceCaseKey: "upstream/refunds/partial",
              approvedBy: "user_9",
              approvedAt: 1_756_100_000_000,
              reason: "Reviewed against the upstream rubric; ENG-4821.",
            },
          ],
          issues: [],
        },
        isLoading: false,
      });

      renderRun();
      const card = screen.getByTestId("import-evidence-card");
      expect(within(card).getByText("ui_refund_partial")).toBeInTheDocument();
      // WHO and WHEN come from the RUN, never from the current session.
      expect(within(card).getByText(/user_9/)).toBeInTheDocument();
      expect(
        within(card).getByText(/Reviewed against the upstream rubric/),
      ).toBeInTheDocument();
      expect(
        within(card).getByText(/upstream\/refunds\/partial/),
      ).toBeInTheDocument();
      // The claimed-exact half says what an exact claim actually rests on.
      expect(
        within(card).getByText(/did not verify semantic equivalence/),
      ).toBeInTheDocument();
    });

    it('describes incomplete evidence as "not gateable", not as a failure', () => {
      vi.mocked(useRunImportEligibility).mockReturnValue({
        eligibility: {
          status: "incomplete",
          gateable: false,
          importedCaseCount: 1,
          claimedExactCaseIds: [],
          approvedApproximationCaseIds: [],
          approvedApproximationReceipts: [],
          issues: [
            {
              code: "APPROXIMATION_NOT_APPROVED",
              caseKey: "ui_refund_partial",
            },
          ],
        },
        isLoading: false,
      });

      renderRun();
      const card = screen.getByTestId("import-evidence-card");
      expect(within(card).getByText(/not gateable/i)).toBeInTheDocument();
      expect(
        within(card).getByText(/not a test failure/i),
      ).toBeInTheDocument();
      expect(
        within(card).getByText(/APPROXIMATION_NOT_APPROVED/),
      ).toBeInTheDocument();
      // Never the language of a verdict: the run has not said the server
      // regressed.
      expect(within(card).queryByText(/\bfailed\b/i)).not.toBeInTheDocument();
    });

    it("renders nothing for a native run, and nothing while loading", () => {
      vi.mocked(useRunImportEligibility).mockReturnValue({
        eligibility: {
          status: "legacy",
          gateable: true,
          importedCaseCount: 0,
          claimedExactCaseIds: [],
          approvedApproximationCaseIds: [],
          approvedApproximationReceipts: [],
          issues: [],
        },
        isLoading: false,
      });
      const { unmount } = renderRun();
      expect(screen.queryByTestId("import-evidence-card")).toBeNull();
      unmount();

      vi.mocked(useRunImportEligibility).mockReturnValue({
        eligibility: undefined,
        isLoading: true,
      });
      renderRun();
      // A "no imported cases" placeholder during the fetch would be a claim,
      // and this state supports none.
      expect(screen.queryByTestId("import-evidence-card")).toBeNull();
    });
  });

  it("uses a vertically scrollable root so expanded triage can exceed the viewport", () => {
    const { container } = render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
        omitIterationList
      />
    );

    const root = container.firstElementChild;
    expect(root).toHaveClass("overflow-y-auto");
    expect(root).not.toHaveClass("overflow-hidden");
  });

  it("renders the Export action even when the accuracy hero is hidden (folded run detail)", async () => {
    const onExportTraces = vi.fn();
    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
        // The main EvalsTab path is folded: hides KPI strip + accuracy hero.
        hideKpiStrip
        hideAccuracyHero
        onExportTraces={onExportTraces}
      />
    );

    const exportButton = screen.getByTestId("run-detail-export-traces");
    expect(exportButton).toBeInTheDocument();
    await userEvent.click(exportButton);
    expect(onExportTraces).toHaveBeenCalledTimes(1);
  });

  it("renders Share on a plugin-free run when onShare is provided", async () => {
    const onShare = vi.fn();
    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
        hideAccuracyHero
        onShare={onShare}
      />
    );
    const shareButton = screen.getByTestId("run-detail-share");
    expect(shareButton).toBeInTheDocument();
    await userEvent.click(shareButton);
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it("omits the Export action when no handler is provided", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
        hideAccuracyHero
      />
    );
    expect(
      screen.queryByTestId("run-detail-export-traces")
    ).not.toBeInTheDocument();
  });

  it("places body KPI strip below the run hero band and above the resizable group", () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query.includes("min-width: 1024px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />
    );

    const kpiStrip = screen.getByText("Passed").closest(".mb-4");
    expect(kpiStrip).not.toBeNull();
    const kpi = within(kpiStrip as HTMLElement);
    expect(kpi.getByText("Passed")).toBeInTheDocument();
    expect(kpi.getByText("Failed")).toBeInTheDocument();
    expect(kpi.getByText("Total")).toBeInTheDocument();
    expect(kpi.getByText("Duration")).toBeInTheDocument();
    // Scope to the KPI strip: the run hero also renders "100" (accuracy 100%),
    // so a global query is ambiguous.
    expect(kpi.getByText(/^100$/)).toBeInTheDocument();

    const runHeading = screen.getByRole("heading", { name: /Run run-1/i });
    const panelGroup = screen.getByTestId("run-detail-resizable-group");
    expect(
      runHeading.compareDocumentPosition(panelGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    expect(
      screen.queryByRole("heading", { name: "Latency by test (p50 / p95)" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Tokens by test (p50 / p95)" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("does not render compact run stats in a duplicate page header", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />
    );

    expect(
      screen.queryByText(/1 passed · 0 failed · 100%/)
    ).not.toBeInTheDocument();
  });

  it("keeps run-level KPIs visible with the iteration list in a resizable two-column layout", () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query.includes("min-width: 1024px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />
    );

    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.getByText(/Test cases/)).toBeInTheDocument();
    expect(screen.getByText("P50")).toBeInTheDocument();
    expect(screen.getByText("Fail")).toBeInTheDocument();
    expect(
      screen.getByTestId("run-detail-resizable-group")
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("run-detail-resizable-panel")).toHaveLength(2);
    expect(
      screen.getByTestId("run-detail-resizable-handle")
    ).toBeInTheDocument();
  });

  it("uses flush split chrome when folded into the suite results surface", () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query.includes("min-width: 1024px"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { container } = render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
        hideKpiStrip
        hideAccuracyHero
      />
    );

    const root = container.firstElementChild;
    expect(root).toHaveClass("p-0");
    expect(root).not.toHaveClass("p-4");
  });

  it("omits the Host metadata row when folded into the suite results split", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun({ namedHostId: "host-copilot" })}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
        hideKpiStrip
        hideAccuracyHero
        hostNamesById={new Map([["host-copilot", "Copilot"]])}
      />
    );

    expect(screen.queryByText("Client")).not.toBeInTheDocument();
    expect(screen.queryByText("Copilot")).not.toBeInTheDocument();
  });

  it("shows the Host metadata row when not embedded and the accuracy hero is hidden", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun({ namedHostId: "host-copilot" })}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
        hideAccuracyHero
        omitIterationList
        hostNamesById={new Map([["host-copilot", "Copilot"]])}
      />
    );

    expect(screen.getByText("Client")).toBeInTheDocument();
    expect(screen.getByText("Copilot")).toBeInTheDocument();
  });

  it("does not surface per-iteration case insight captions in the run view (open a test from the list to inspect a case)", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun({
          runInsights: {
            summary: "suite level",
            generatedAt: 1,
            modelUsed: "m",
            caseInsights: [
              {
                caseKey: "ck-match",
                testCaseId: "tc-1",
                title: "t",
                status: "new_failure",
                summary:
                  "Only shown in test editor or case detail, not run list",
              },
            ],
          },
        })}
        caseGroupsForSelectedRun={[
          makeIteration({
            _id: "iter-case",
            testCaseId: "tc-1",
            testCaseSnapshot: {
              title: "Test A",
              query: "q",
              provider: "openai",
              model: "gpt-4",
              expectedToolCalls: [],
              caseKey: "ck-match",
            },
          }),
        ]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId="iter-case"
        onSelectIteration={() => {}}
      />
    );
    expect(
      screen.queryByTestId("run-case-insight-trace-caption")
    ).not.toBeInTheDocument();
  });

  it("shows pass rate in Overview sidebar row and not the full compact stats line", () => {
    const run = makeRun({
      summary: { total: 7, passed: 6, failed: 1, passRate: 6 / 7 },
    });
    render(
      <RunIterationsSidebar
        caseGroupsForSelectedRun={[]}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
        runForOverview={run}
        onOpenRunInsights={() => {}}
      />
    );

    expect(
      screen.getByRole("button", {
        name: /Overview — show in main panel — 86%/,
      })
    ).toBeInTheDocument();
    expect(screen.getByText("86%")).toBeInTheDocument();
    expect(
      screen.queryByText(/6 passed · 1 failed · 86%/)
    ).not.toBeInTheDocument();
  });

  it("shows iteration sort options from an icon dropdown", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();

    render(
      <RunIterationsSidebar
        caseGroupsForSelectedRun={[makeIteration()]}
        runDetailSortBy="test"
        onSortChange={onSortChange}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Sort iterations: Test" })
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Result" })
    );

    expect(onSortChange).toHaveBeenCalledWith("result");
  });

  it("shows grouped case metric columns in the iteration sidebar", () => {
    render(
      <RunIterationsSidebar
        caseGroupsForSelectedRun={[
          makeIteration({ testCaseId: "tc-1", startedAt: 0, updatedAt: 1500 }),
        ]}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />
    );
    expect(screen.getByText("Case")).toBeInTheDocument();
    expect(screen.getByText("P50")).toBeInTheDocument();
    expect(screen.getByText("P95")).toBeInTheDocument();
  });

  it("keeps the main run list aligned with the suite cases table: no Overview row, sort in the header row", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun({
          summary: { total: 7, passed: 6, failed: 1, passRate: 6 / 7 },
        })}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />
    );

    expect(
      screen.queryByRole("button", {
        name: /Overview — show in main panel/,
      })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sort iterations: Test" })
    ).toBeInTheDocument();
  });

  it("exposes view-case aria-label on grouped case row button", () => {
    render(
      <RunIterationsSidebar
        caseGroupsForSelectedRun={[
          makeIteration({ testCaseId: "tc-1", result: "passed" }),
        ]}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />
    );

    expect(
      screen.getByRole("button", {
        name: "View Test A: 1 of 1 passed",
      })
    ).toBeInTheDocument();
  });
});
