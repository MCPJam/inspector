import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { SuiteHeader } from "../suite-header";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null, isLoading: false, signIn: vi.fn() }),
}));

const mockIsHostedMode = vi.fn(() => false);
vi.mock("@/lib/apis/mode-client", () => ({
  isHostedMode: () => mockIsHostedMode(),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

// Consumed by the RunDetailPlaygroundActions child (replay snapshot gate);
// pinned `true` so header tests never see a cloud-gated state they didn't ask
// for. The derivation itself lives in suite-iterations-view, not here.
const cloudState = vi.hoisted(() => ({
  ephemeralAvailable: true as boolean | undefined,
}));
vi.mock("@/hooks/useProjectComputer", () => ({
  useEphemeralCloudAvailable: () => cloudState.ephemeralAvailable,
}));

vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: () => null,
}));

describe("SuiteHeader", () => {
  const baseSuite = {
    _id: "suite-1",
    createdBy: "user-1",
    name: "Asana MCP Evals",
    description: "CI suite",
    configRevision: "1",
    environment: { servers: ["asana"] },
    createdAt: 1,
    updatedAt: 1,
    source: "sdk" as const,
  };

  const baseRun = {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: {
      tests: [],
      environment: { servers: ["asana"] },
    },
    status: "completed" as const,
    source: "sdk" as const,
    hasServerReplayConfig: true,
    createdAt: 1_000,
    completedAt: 136_000,
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
  };

  const baseProps = {
    suite: baseSuite,
    viewMode: "run-detail" as const,
    selectedRunDetails: baseRun,
    isEditMode: false,
    onRerun: vi.fn(),
    onReplayRun: vi.fn(),
    onCancelRun: vi.fn(),
    onViewModeChange: vi.fn(),
    connectedServerNames: new Set<string>(),
    rerunningSuiteId: null,
    cancellingRunId: null,
    runs: [baseRun],
    allIterations: [],
    aggregate: null,
    testCases: [],
    availableModels: [],
    readOnlyConfig: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cloudState.ephemeralAvailable = true;
    mockIsHostedMode.mockReturnValue(false);
  });

  it("shows compact run stats under the run title in run detail when no KPI strip", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        selectedRunDetails={{
          ...baseRun,
          summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
        }}
      />
    );
    expect(screen.getByText(/1 passed · 1 failed · 50%/)).toBeInTheDocument();
  });

  it("omits run identity when consolidated into the accuracy hero band", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        selectedRunDetails={{
          ...baseRun,
          summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
        }}
        omitRunDetailIdentity
      />
    );
    expect(
      screen.queryByRole("heading", { name: /Run run-1/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/1 passed · 1 failed/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Replay this run" })
    ).toBeInTheDocument();
  });

  it("keeps suite overview chrome when run identity is omitted and run actions are hidden", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        hideRunActions
        showTestCaseCtas
        omitRunDetailIdentity
      />
    );

    expect(screen.getByText("Asana MCP Evals")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Run run-1/i })
    ).not.toBeInTheDocument();
  });

  it("hides compact run stats when the KPI strip is shown", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        selectedRunDetails={{
          ...baseRun,
          summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
        }}
        runDetailKpiStrip={<div data-testid="run-kpi-strip">kpis</div>}
      />
    );
    expect(
      screen.queryByText(/1 passed · 1 failed · 50%/)
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("run-kpi-strip")).toBeInTheDocument();
  });

  it("shows replay lineage under the run title when replayedFromRunId is set", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        selectedRunDetails={{
          ...baseRun,
          replayedFromRunId: "n573zfck8sdhjg7by2s31ex2yx83m6sh",
        }}
      />
    );

    expect(screen.getByText("Replay of")).toBeTruthy();
    expect(screen.getByText("Run n573zfck")).toBeTruthy();
  });

  it("shows a replay action for replayable CI runs in read-only run detail", async () => {
    const user = userEvent.setup();

    renderWithProviders(<SuiteHeader {...baseProps} />);

    const replayButton = screen.getByRole("button", {
      name: "Replay this run",
    });
    expect(replayButton).toBeTruthy();
    expect(replayButton).not.toBeDisabled();

    await user.click(replayButton);

    expect(baseProps.onReplayRun).toHaveBeenCalledWith(baseSuite, baseRun);
    expect(baseProps.onRerun).not.toHaveBeenCalled();
  });

  it("hides run-detail actions when run actions are suppressed", () => {
    renderWithProviders(<SuiteHeader {...baseProps} hideRunActions />);

    expect(
      screen.queryByRole("button", { name: "Replay this run" })
    ).toBeNull();
  });

  it("shows replay latest run in overview without hosted-mode gating", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
      />
    );

    expect(
      screen.getByRole("button", { name: "Replay latest run" })
    ).toBeTruthy();
  });

  it("truncates a very long read-only suite name in overview and keeps full name in title", () => {
    const longName = "excalidraw " + "x".repeat(200);
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        suite={{ ...baseSuite, name: longName }}
        readOnlyConfig
      />
    );

    const heading = screen.getByRole("heading", { level: 2, name: longName });
    expect(heading).toHaveClass("truncate");
    expect(heading).toHaveAttribute("title", longName);
  });

  it("hides overview run actions when run actions are suppressed", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        hideRunActions
      />
    );

    expect(
      screen.queryByRole("button", { name: "Replay latest run" })
    ).toBeNull();
  });

  it("shows Cases when cases sidebar is hidden on runs overview", async () => {
    const user = userEvent.setup();
    const onShowCasesSidebar = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        runsViewMode="runs"
        casesSidebarHidden
        onShowCasesSidebar={onShowCasesSidebar}
      />
    );

    await user.click(screen.getByRole("button", { name: "Cases" }));

    expect(onShowCasesSidebar).toHaveBeenCalled();
  });

  it("fires the export callback when Setup SDK is clicked", async () => {
    const user = userEvent.setup();
    const onOpenExportSuite = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        onOpenExportSuite={onOpenExportSuite}
      />
    );

    await user.click(screen.getByRole("button", { name: "Setup SDK" }));

    expect(onOpenExportSuite).toHaveBeenCalledTimes(1);
  });

  it("shows a loading state on Generate in test-cases overview while generating", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        runsViewMode="test-cases"
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases
        isGeneratingTestCases
      />
    );

    const generateBtn = screen.getByRole("button", { name: /generate/i });
    expect(generateBtn).toHaveAttribute("aria-busy", "true");
    expect(generateBtn).toBeDisabled();
    expect(generateBtn.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("shows Generate and New case on unified suite dashboard when URL is still ?view=runs", () => {
    const onCreate = vi.fn();
    const onGenerate = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        runsViewMode="runs"
        hideRunActions
        unifiedSuiteDashboard
        onCreateTestCase={onCreate}
        onGenerateTestCases={onGenerate}
        canGenerateTestCases
      />
    );

    expect(
      screen.getByRole("button", { name: "New case" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /generate/i })
    ).toBeInTheDocument();
  });

  it("shows Run all in the playground header and calls onRerun", async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        onRerun={onRerun}
        runsViewMode="runs"
        hideRunActions
        unifiedSuiteDashboard
        onCreateTestCase={vi.fn()}
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases
        testCases={[
          {
            _id: "c1",
            models: [{ provider: "openai", model: "gpt-4" }],
          } as any,
        ]}
        connectedServerNames={new Set(["asana"])}
      />
    );

    const runAll = screen.getByRole("button", {
      name: /Run all cases in this suite/i,
    });
    expect(runAll).toBeEnabled();
    await user.click(runAll);
    expect(onRerun).toHaveBeenCalledWith(baseSuite, {});
  });

  it("blocks Run all when the parent-derived evalRunsDisabledReason is set", () => {
    // The cloud-sandbox preflight is derived in suite-iterations-view (the
    // owner of every run control) and arrives here as a plain prop — this
    // pins that the header honors it.
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        evalRunsDisabledReason="This suite pins a sandbox image, but this inspector can't run MCPJam cloud sandboxes."
        viewMode="overview"
        selectedRunDetails={null}
        runsViewMode="runs"
        hideRunActions
        unifiedSuiteDashboard
        onCreateTestCase={vi.fn()}
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases
        testCases={[
          {
            _id: "c1",
            models: [{ provider: "openai", model: "gpt-4" }],
          } as any,
        ]}
        connectedServerNames={new Set(["asana"])}
      />
    );

    expect(
      screen.getByRole("button", { name: /Run all cases in this suite/i })
    ).toBeDisabled();
  });

  it("keeps Run all disabled while the latest suite run is still running", async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        onRerun={onRerun}
        runs={[{ ...baseRun, status: "running", completedAt: undefined }]}
        runsViewMode="runs"
        hideRunActions
        unifiedSuiteDashboard
        onCreateTestCase={vi.fn()}
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases
        testCases={[
          {
            _id: "c1",
            models: [{ provider: "openai", model: "gpt-4" }],
          } as any,
        ]}
        connectedServerNames={new Set(["asana"])}
      />
    );

    const runAll = screen.getByRole("button", {
      name: /Run all cases in this suite/i,
    });
    expect(runAll).toBeDisabled();
    await user.click(runAll);
    expect(onRerun).not.toHaveBeenCalled();
  });

  it("wraps overview actions onto a second row, right-aligned, with Run all last", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        runsViewMode="runs"
        hideRunActions
        unifiedSuiteDashboard
        onCreateTestCase={vi.fn()}
        onGenerateTestCases={vi.fn()}
        onOpenExportSuite={vi.fn()}
        canGenerateTestCases
        testCases={[
          {
            _id: "c1",
            models: [{ provider: "openai", model: "gpt-4" }],
          } as any,
        ]}
        connectedServerNames={new Set(["asana"])}
      />
    );

    const header = screen.getByTestId("suite-overview-header");
    expect(header).toHaveClass("flex");
    expect(header).toHaveClass("flex-wrap");
    expect(header).toHaveClass("min-w-0");

    const leftCluster = header.children[0] as HTMLElement;
    expect(leftCluster).toHaveClass("min-w-0");
    expect(
      Array.from(leftCluster.querySelectorAll<HTMLElement>("*")).some((el) =>
        el.className.includes("max-w-[20rem]")
      )
    ).toBe(true);

    const actions = screen.getByTestId("suite-overview-actions");
    expect(actions).toHaveClass("ml-auto");
    expect(actions).toHaveClass("flex-wrap");
    expect(actions).toHaveClass("justify-end");

    const setupSdk = screen.getByRole("button", { name: /Setup SDK/i });
    const generate = screen.getByRole("button", { name: /^Generate$/i });
    const newCase = screen.getByRole("button", { name: /New case/i });
    const runAll = screen.getByRole("button", {
      name: /Run all cases in this suite/i,
    });
    expect(setupSdk.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(generate.compareDocumentPosition(newCase) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(newCase.compareDocumentPosition(runAll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("suite-environment-bar")).toBeNull();
  });

  it("does not show Compare clients in the suite overview header", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        runsViewMode="runs"
        hideRunActions
        unifiedSuiteDashboard
        onCreateTestCase={vi.fn()}
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases
        suite={{
          ...baseSuite,
          hostAttachments: [
            {
              namedHostId: "cursor",
              hostName: "Cursor",
              resolvedServerNames: ["asana"],
            },
            {
              namedHostId: "claude",
              hostName: "Claude",
              resolvedServerNames: ["asana"],
            },
          ],
        }}
      />
    );

    expect(
      screen.queryByRole("button", { name: /Compare attached clients/i })
    ).toBeNull();
  });

  it("forwards iterationOverride on Run all even without a match-options override", async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        onRerun={onRerun}
        runsViewMode="runs"
        hideRunActions
        unifiedSuiteDashboard
        onCreateTestCase={vi.fn()}
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases
        testCases={[
          {
            _id: "c1",
            models: [{ provider: "openai", model: "gpt-4" }],
          } as any,
        ]}
        connectedServerNames={new Set(["asana"])}
        iterationOverride={3}
      />
    );

    await user.click(
      screen.getByRole("button", { name: /Run all cases in this suite/i })
    );

    expect(onRerun).toHaveBeenCalledWith(baseSuite, { iterationOverride: 3 });
  });

  /**
   * S5 — the settings header has no Done button. Saving lives in the commit bar.
   */
  describe("settings header", () => {
    const editProps = {
      ...baseProps,
      isEditMode: true,
      viewMode: "overview" as const,
      selectedRunDetails: null,
      readOnlyConfig: false,
    };

    it("has no Done button", () => {
      renderWithProviders(<SuiteHeader {...editProps} />);
      expect(screen.queryByRole("button", { name: /^Done$/ })).toBeNull();
    });

    it("edits the suite name through the settings draft", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderWithProviders(
        <SuiteHeader
          {...editProps}
          settingsDraftName={{
            value: "Test Suite",
            onChange,
          }}
        />,
      );
      await user.click(screen.getByRole("button", { name: "Test Suite" }));
      const input = screen.getByRole("textbox", { name: "Suite name" });
      await user.clear(input);
      await user.type(input, "Renamed");
      expect(onChange).toHaveBeenCalled();
    });

    it("does NOT edit the name when CI owns the suite", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderWithProviders(
        <SuiteHeader
          {...editProps}
          configLocked
          settingsDraftName={{ value: "Test Suite", onChange }}
        />,
      );

      // The name is the one setting outside the sheet's `fieldset[disabled]`,
      // and this header became reachable for a CI-owned suite on purpose — its
      // settings are that suite's documentation. Editable, it would feed the
      // draft, put the suite in the commit flow, and end in the 409 the rest
      // of the sheet exists to avoid offering.
      expect(screen.getByText("Test Suite")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Test Suite" }),
      ).toBeNull();
      expect(
        screen.queryByRole("textbox", { name: "Suite name" }),
      ).toBeNull();
      await user.click(screen.getByText("Test Suite"));
      expect(
        screen.queryByRole("textbox", { name: "Suite name" }),
      ).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});

/**
 * The Evals unified dashboard renders its case toolbar from THIS header, while
 * Evaluate renders it from `SuiteDetailOverview`. So the CI-owned rule has to
 * be stated in both places, and this is the half that was missed: Generate and
 * New case start flows that end in a `case.create` the platform refuses with
 * `CI_OWNED_SUITE_READ_ONLY`.
 */
describe("SuiteHeader — a suite managed by CI", () => {
  const overviewProps = {
    suite: {
      _id: "suite-1",
      createdBy: "user-1",
      name: "Asana MCP Evals",
      description: "CI suite",
      configRevision: "1",
      environment: { servers: ["asana"] },
      createdAt: 1,
      updatedAt: 1,
      source: "sdk" as const,
      declaredSuiteId: "s_from_file",
    },
    viewMode: "overview" as const,
    selectedRunDetails: null,
    isEditMode: false,
    onRerun: vi.fn(),
    onReplayRun: vi.fn(),
    onCancelRun: vi.fn(),
    onViewModeChange: vi.fn(),
    connectedServerNames: new Set<string>(["asana"]),
    hasServersConfigured: true,
    rerunningSuiteId: null,
    cancellingRunId: null,
    runs: [],
    allIterations: [],
    aggregate: null,
    testCases: [],
    availableModels: [],
    runsViewMode: "test-cases" as const,
    onGenerateTestCases: vi.fn(),
    onCreateTestCase: vi.fn(),
    canGenerateTestCases: true,
    hideRunActions: true,
    unifiedSuiteDashboard: true,
  };

  it("offers no case authoring", () => {
    renderWithProviders(<SuiteHeader {...(overviewProps as never)} configLocked />);

    expect(screen.queryByRole("button", { name: /Generate/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /New case/i })).toBeNull();
  });

  it("still offers case authoring on an app-authored suite", () => {
    // The guard against over-locking: the same header, unlocked, is unchanged.
    renderWithProviders(<SuiteHeader {...(overviewProps as never)} />);

    expect(screen.getByRole("button", { name: /Generate/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /New case/i })).toBeTruthy();
  });

  it("keeps Run all — running a CI-owned suite is the point", () => {
    renderWithProviders(
      <SuiteHeader
        {...(overviewProps as never)}
        testCases={[{ _id: "case-1" } as never]}
        configLocked
      />,
    );

    // `showTestCaseCtas` gates Run all as well as the authoring buttons, which
    // is why the lock keys off a separate derivation rather than that flag.
    expect(screen.getByRole("button", { name: /Run all/i })).toBeTruthy();
  });

  it("offers no Setup CI or Settings on a locked suite", () => {
    renderWithProviders(
      <SuiteHeader
        {...(overviewProps as never)}
        onSetupCi={vi.fn()}
        configLocked
      />,
    );

    // Setup CI wires a suite INTO CI; a suite CI already owns has nothing to
    // wire, and the flow writes suite configuration.
    expect(screen.queryByRole("button", { name: /Setup CI/i })).toBeNull();
  });
});
