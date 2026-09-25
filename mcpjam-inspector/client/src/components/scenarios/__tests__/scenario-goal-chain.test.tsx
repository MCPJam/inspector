/**
 * The per-goal user value chain: the probe, and the tab that paints it.
 *
 * Run against a FIXTURE funnel rather than a deployment. Two backend
 * arguments feed this — `clusterId` (mcpjam-backend#1294, merged) and
 * `sentiment` (mcpjam-backend#1329, open) — so these tests are how the wiring
 * is held to its contract until both are deployed, and the cheaper check
 * afterwards.
 *
 * The query is addressed as an `as never` string, so NOTHING mechanical will
 * notice when this list goes stale. Adding an argument means updating it here.
 *
 * The behaviours worth pinning are the ones that are invisible when they go
 * wrong:
 *
 *  - A failed query leaves the chain UNMEASURED and still reports. Falling
 *    back is not the same as swallowing: a backend that lost `clusterId` is a
 *    rollback, and a tab that quietly rendered "no finding" through it would
 *    look exactly like a healthy study with nothing to say.
 *  - An answer for a goal the reader has closed never paints the goal they
 *    opened next.
 *  - `undefined` is loading, not an answer.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { USER_VALUE_STAGES, type UserValueStage } from "@mcpjam/sdk/contract";
import type { ChatSessionStageFunnel } from "@/components/shared/user-value-chain/user-value-chain-types";
import { ScenarioGoalChain } from "@/components/scenarios/findings/scenario-goal-chain";
import { ScenarioFindingsTab } from "@/components/scenarios/findings/scenario-findings-tab";

const {
  mockUseQuery,
  mockUseGoalOutcomeDrilldown,
  mockUseUsageInsights,
  mockReportBoundaryError,
} = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockUseGoalOutcomeDrilldown: vi.fn(),
  mockUseUsageInsights: vi.fn(),
  mockReportBoundaryError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

// The tab reads the breakdown too, for the one signal the drill-down cannot
// give it: whether an analysis has ever run (BB-196).
vi.mock("@/hooks/useUsageInsights", () => ({
  useGoalOutcomeDrilldown: (...args: unknown[]) =>
    mockUseGoalOutcomeDrilldown(...args),
  useUsageInsights: (...args: unknown[]) => mockUseUsageInsights(...args),
}));

vi.mock("@/lib/error-reporting", () => ({
  reportBoundaryError: (...args: unknown[]) => mockReportBoundaryError(...args),
}));

// Analyze now is offered to members only; the check is a Convex query.
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => true,
}));

// ── fixtures ────────────────────────────────────────────────────────────────

type TallySpec = {
  passed?: number;
  failed?: number;
  notMeasured?: number;
  notReached?: number;
};

function funnelOf(
  rows: Partial<Record<UserValueStage, TallySpec>>,
  over: Partial<
    Pick<ChatSessionStageFunnel, "total" | "counted" | "firstFailedStage">
  > = {},
): ChatSessionStageFunnel {
  const stages = USER_VALUE_STAGES.map((stage) => {
    const spec = rows[stage] ?? {};
    const passed = spec.passed ?? 0;
    const failed = spec.failed ?? 0;
    const eligible = passed + failed;
    const notMeasured = spec.notMeasured ?? 0;
    const notReached = spec.notReached ?? 0;
    return {
      stage,
      passed,
      failed,
      eligible,
      notMeasured,
      notApplicable: 0,
      notReached,
      observations: eligible + notMeasured + notReached,
      passRate: eligible === 0 ? null : passed / eligible,
    };
  });
  const counted =
    over.counted ?? Math.max(0, ...stages.map((row) => row.observations));
  return {
    source: "user_testing",
    total: over.total ?? counted,
    counted,
    exclusions: { absent: 0, deriving: 0, stale: 0, failed: 0 },
    stages,
    firstFailedStage: over.firstFailedStage ?? {},
    notMeasured: stages.every((row) => row.observations === 0),
    truncated: false,
  };
}

/** Two sessions on one goal cluster, both frustrated, both unresolved. */
function drilldownFixture() {
  return {
    sessions: [
      {
        _id: "sess-1",
        sentiment: "frustrated" as const,
        themeClusterId: "cluster-export",
        themeClusterLabel: "Export the board",
        outcome: "unresolved" as const,
      },
      {
        _id: "sess-2",
        sentiment: "frustrated" as const,
        themeClusterId: "cluster-export",
        themeClusterLabel: "Export the board",
        outcome: "unresolved" as const,
      },
    ],
    nextBefore: null,
    total: 2,
    totalTruncated: false,
  };
}

/** Two goals under one persona, so a chain can be shown the wrong one. */
function twoGoalDrilldown() {
  const base = drilldownFixture();
  return {
    ...base,
    sessions: [
      ...base.sessions,
      {
        _id: "sess-3",
        sentiment: "frustrated" as const,
        themeClusterId: "cluster-browse",
        themeClusterLabel: "Browse the catalog",
        outcome: "unresolved" as const,
      },
    ],
    total: 3,
  };
}

beforeEach(() => {
  mockUseQuery.mockReset();
  mockUseGoalOutcomeDrilldown.mockReset();
  mockUseUsageInsights.mockReset();
  mockReportBoundaryError.mockReset();
  // A study already analyzed: these tests are about the chain, not about the
  // first-analysis start, so `latestRun` keeps that path out of them.
  mockUseUsageInsights.mockReturnValue({
    threads: undefined,
    breakdown: {
      totalSessions: 4,
      latestRun: { status: "done" },
    },
    rebuild: vi.fn().mockResolvedValue({
      runId: "run-1",
      status: "queued",
      alreadyRunning: false,
    }),
  });
  mockUseGoalOutcomeDrilldown.mockReturnValue({
    drilldown: drilldownFixture(),
    isLoading: false,
  });
});

// ── the probe ───────────────────────────────────────────────────────────────

describe("ScenarioGoalChain", () => {
  it("asks for the one goal, by cluster, and reports the mapped chain", () => {
    mockUseQuery.mockReturnValue(
      funnelOf(
        { connection: { passed: 4 }, discovery: { failed: 4 } },
        { counted: 4, total: 4, firstFailedStage: { discovery: 4 } },
      ),
    );
    const onResolved = vi.fn();

    render(
      <ScenarioGoalChain
        scenarioId="scn-1"
        goalId="cluster-export"
        onResolved={onResolved}
      />,
    );

    expect(mockUseQuery).toHaveBeenCalledWith(
      "chatSessionStageDerivation:getScenarioStageFunnel",
      { scenarioId: "scn-1", clusterId: "cluster-export" },
    );
    // ABSENT, not `undefined`. `toHaveBeenCalledWith` uses `toEqual`
    // semantics, which ignore undefined-valued keys — so the assertion above
    // is satisfied by `{ …, sentiment: undefined }`, which the server rejects
    // at argument validation. Simplifying the spread to a plain `sentiment,`
    // would pass every other test in this file and ship that error.
    const args = mockUseQuery.mock.calls.at(-1)![1] as object;
    expect("sentiment" in args).toBe(false);
    expect(onResolved).toHaveBeenCalledTimes(1);
    const [about, stages] = onResolved.mock.calls[0]!;
    // Named with the population it is about, so a stale answer is
    // recognisable — no persona is selected here, so there is no sentiment.
    expect(about).toEqual({ goalId: "cluster-export", sentiment: undefined });
    expect(stages?.stages.discovery.state).toBe("fail");
    expect(stages?.defaultStage).toBe("discovery");
  });

  it("says nothing while the query is still loading", () => {
    mockUseQuery.mockReturnValue(undefined);
    const onResolved = vi.fn();

    render(
      <ScenarioGoalChain
        scenarioId="scn-1"
        goalId="cluster-export"
        onResolved={onResolved}
      />,
    );

    // Reporting `undefined` would blank a chain the reader is already reading.
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("passes on a backend that cannot answer for this goal", () => {
    // `null` is the backend's answer for a deleted cluster or a non-goal axis.
    // It is an answer, not an absence, and must reach the tab.
    mockUseQuery.mockReturnValue(null);
    const onResolved = vi.fn();

    render(
      <ScenarioGoalChain
        scenarioId="scn-1"
        goalId="cluster-export"
        onResolved={onResolved}
      />,
    );

    expect(onResolved).toHaveBeenCalledWith(
      { goalId: "cluster-export", sentiment: undefined },
      null,
    );
  });

  it("falls back to unmeasured on a throw, and still reports the throw", () => {
    // The rollback case: a deployment without the `clusterId` argument rejects
    // the call. The tab must survive it, and someone must hear about it.
    mockUseQuery.mockImplementation(() => {
      throw new Error("ArgumentValidationError: extra field `clusterId`");
    });
    const onResolved = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <ScenarioGoalChain
        scenarioId="scn-1"
        goalId="cluster-export"
        onResolved={onResolved}
      />,
    );

    expect(onResolved).toHaveBeenCalledWith(
      { goalId: "cluster-export", sentiment: undefined },
      null,
    );
    // Not swallowed. This is the assertion that separates a real fallback from
    // a silenced alarm.
    expect(mockReportBoundaryError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// ── the tab ─────────────────────────────────────────────────────────────────

describe("the Findings tab observes server-owned analysis", () => {
  /** Sessions exist but none is analyzed — the state a tester lands on. */
  function unanalyzed() {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [
          { _id: "s-1", threadId: "t-1", lastActivityAt: 1 },
          { _id: "s-2", threadId: "t-2", lastActivityAt: 2 },
        ],
        nextBefore: null,
        total: 2,
        totalTruncated: false,
      },
      isLoading: false,
    });
  }

  it("does not queue analysis when a study opens", async () => {
    unanalyzed();
    const rebuild = vi.fn().mockResolvedValue({
      runId: "run-1",
      status: "queued",
      alreadyRunning: false,
    });
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: { totalSessions: 2, latestRun: null },
      rebuild,
    });

    render(<ScenarioFindingsTab scenarioId="scn-1" />);

    expect(rebuild).not.toHaveBeenCalled();
    expect(screen.getByTestId("scenario-findings-empty")).toHaveTextContent(
      "No session has been analyzed yet.",
    );
  });

  it("keeps unanalyzed sessions explicit without attempting a rebuild", async () => {
    // A signed-out guest: the rebuild mutation authenticates, so nothing is
    // ever coming and a spinner would be a lie.
    unanalyzed();
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: { totalSessions: 2, latestRun: null },
      rebuild: vi.fn().mockRejectedValue(new Error("Not authenticated")),
    });

    render(<ScenarioFindingsTab scenarioId="scn-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("scenario-findings-empty")).toHaveTextContent(
        "No session has been analyzed yet.",
      ),
    );
  });

  it("does not start one for a study with no sessions", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [],
        nextBefore: null,
        total: 0,
        totalTruncated: false,
      },
      isLoading: false,
    });
    const rebuild = vi.fn();
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: { totalSessions: 0, latestRun: null },
      rebuild,
    });

    render(<ScenarioFindingsTab scenarioId="scn-1" />);

    expect(rebuild).not.toHaveBeenCalled();
    expect(screen.getByTestId("scenario-findings-empty")).toHaveTextContent(
      "No sessions in this study yet.",
    );
  });

  it("shows the empty panel it is handed for a study with no sessions", () => {
    // The detail page hands Insights' own empty panel in, so an unrun study
    // reads the same on both tabs instead of Findings being a blank frame.
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [],
        nextBefore: null,
        total: 0,
        totalTruncated: false,
      },
      isLoading: false,
    });
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: { totalSessions: 0, latestRun: null },
      rebuild: vi.fn(),
    });

    render(
      <ScenarioFindingsTab
        scenarioId="scn-1"
        emptyState={<div data-testid="handed-empty-panel" />}
      />,
    );

    expect(screen.getByTestId("handed-empty-panel")).toBeInTheDocument();
    expect(
      screen.queryByText("No sessions in this study yet."),
    ).not.toBeInTheDocument();
  });

  it("keeps the analysis notice, not the empty panel, for waiting sessions", () => {
    // Sessions that exist but are not analyzed are a different problem; the
    // share panel would tell the creator to go get sessions they already have.
    unanalyzed();
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: { totalSessions: 2, latestRun: null },
      rebuild: vi.fn(),
    });

    render(
      <ScenarioFindingsTab
        scenarioId="scn-1"
        emptyState={<div data-testid="handed-empty-panel" />}
      />,
    );

    expect(screen.queryByTestId("handed-empty-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("scenario-findings-empty")).toHaveTextContent(
      "No session has been analyzed yet.",
    );
  });

  /** The summary the breakdown carries (B5), for one waiting session. */
  function summary(overrides: Record<string, unknown> = {}) {
    return {
      total: 2,
      analyzed: 0,
      owed: 0,
      pending: 0,
      running: 0,
      failed: 0,
      skipped: 0,
      deferred: 0,
      awaitingTaxonomy: 0,
      unassigned: 0,
      staleAssignments: 0,
      projectionPending: 0,
      projectionFailed: 0,
      deferredUntil: null,
      lastAnalyzedAt: null,
      failures: {},
      skips: {},
      sampled: false,
      taxonomies: [],
      ...overrides,
    };
  }

  it("says a session is waiting to go quiet, not 'a few minutes', and offers Analyze now", async () => {
    // The 2026-09-22 report: one tester, "a few minutes", nothing for half an
    // hour. The reason is the session's own settle window.
    const user = userEvent.setup();
    unanalyzed();
    const rebuild = vi.fn().mockResolvedValue({
      status: "queued",
      alreadyRunning: false,
    });
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: {
        totalSessions: 2,
        analysis: summary({
          owed: 2,
          pending: 2,
          nextAnalysisAt: Date.now() + 2 * 60_000,
        }),
      },
      rebuild,
    });

    render(<ScenarioFindingsTab scenarioId="scn-1" />);

    const status = screen.getByTestId("scenario-findings-status");
    expect(status).toHaveAttribute("data-status", "waiting");
    expect(status).toHaveTextContent("Waiting for the session to go quiet");
    expect(status).not.toHaveTextContent("a few minutes");
    expect(rebuild).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Analyze now/ }));
    expect(rebuild).toHaveBeenCalledWith({ settled: true });
  });

  it("counts the sessions actually being analyzed, and offers nothing", () => {
    unanalyzed();
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: {
        totalSessions: 2,
        analysis: summary({ pending: 2, owed: 0, running: 0 }),
      },
      rebuild: vi.fn(),
    });

    render(<ScenarioFindingsTab scenarioId="scn-1" />);

    expect(screen.getByTestId("scenario-findings-status")).toHaveTextContent(
      "Analyzing 2 sessions…",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("leaves an already-analyzed study alone", () => {
    unanalyzed();
    const rebuild = vi.fn();
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: { totalSessions: 2, latestRun: { status: "done" } },
      rebuild,
    });

    render(<ScenarioFindingsTab scenarioId="scn-1" />);

    expect(rebuild).not.toHaveBeenCalled();
  });
});

describe("the Findings tab, once a goal is open", () => {
  it("paints the measured chain and opens on the break", async () => {
    mockUseQuery.mockReturnValue(
      funnelOf(
        {
          connection: { passed: 2 },
          discovery: { failed: 2 },
          response: { notReached: 2 },
        },
        { counted: 2, total: 2, firstFailedStage: { discovery: 2 } },
      ),
    );

    render(<ScenarioFindingsTab scenarioId="scn-1" />);
    await userEvent.click(await screen.findByTestId("findings-goal-row"));

    await waitFor(() =>
      expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
        "data-state",
        "fail",
      ),
    );
    expect(screen.getByTestId("findings-stage-connection")).toHaveAttribute(
      "data-state",
      "ok",
    );
    // Nobody reached it, so it is unknown — NOT a pass.
    expect(screen.getByTestId("findings-stage-response")).toHaveAttribute(
      "data-state",
      "none",
    );
    // The panel lands on the break rather than on the last column.
    expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByText("Discovery failed in every graded session."),
    ).toBeInTheDocument();
  });

  it("leaves every stage unknown when the chain cannot be read", async () => {
    mockUseQuery.mockReturnValue(null);

    render(<ScenarioFindingsTab scenarioId="scn-1" />);
    await userEvent.click(await screen.findByTestId("findings-goal-row"));

    for (const stage of ["connection", "discovery", "value"]) {
      expect(screen.getByTestId(`findings-stage-${stage}`)).toHaveAttribute(
        "data-state",
        "none",
      );
    }
    // The verbatim copy, which says in words that this is not a pass.
    expect(screen.getByTestId("findings-empty-stage")).toBeInTheDocument();
  });

  it("never paints one goal with another goal's chain", async () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: twoGoalDrilldown(),
      isLoading: false,
    });
    // Built ONCE, outside the implementation. The real `useQuery` hands back a
    // reference-stable result for unchanged data, and the chain effect keys on
    // that identity — a mock minting a fresh funnel per render would report,
    // re-render, and report again forever.
    const exportFunnel = funnelOf(
      { connection: { passed: 2 }, discovery: { failed: 2 } },
      { counted: 2, total: 2, firstFailedStage: { discovery: 2 } },
    );
    // The first goal has an answer. The second is still loading, which is the
    // window a stale chain would show through.
    mockUseQuery.mockImplementation((_name: unknown, args: unknown) =>
      (args as { clusterId: string }).clusterId === "cluster-export"
        ? exportFunnel
        : undefined,
    );

    render(<ScenarioFindingsTab scenarioId="scn-1" />);
    const rows = await screen.findAllByTestId("findings-goal-row");
    expect(rows).toHaveLength(2);

    await userEvent.click(rows[0]!);
    await waitFor(() =>
      expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
        "data-state",
        "fail",
      ),
    );

    // Close the answered goal, open the unanswered one.
    await userEvent.click(rows[0]!);
    await userEvent.click(rows[1]!);

    // "Browse the catalog" has no chain yet. Showing the export goal's failure
    // here would be a fabricated diagnosis on a goal nobody measured.
    expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
      "data-state",
      "none",
    );
    expect(screen.getByTestId("findings-empty-stage")).toBeInTheDocument();
  });

  it("keeps the stage the reader picked when the chain has an opinion", async () => {
    mockUseQuery.mockReturnValue(
      funnelOf(
        { connection: { passed: 2 }, discovery: { failed: 2 } },
        { counted: 2, total: 2, firstFailedStage: { discovery: 2 } },
      ),
    );

    render(<ScenarioFindingsTab scenarioId="scn-1" />);
    await userEvent.click(await screen.findByTestId("findings-goal-row"));
    await waitFor(() =>
      expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );

    await userEvent.click(screen.getByTestId("findings-stage-connection"));

    // The chain's own default is `discovery`, and it must not pull the reader
    // back off a stage they chose. This precedence is what makes a chain
    // arriving mid-read safe.
    expect(screen.getByTestId("findings-stage-connection")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("scopes the goal's session list to the persona whose row was counted", async () => {
    // The bug this pins shipped and was caught on a real study: "Creative
    // requests" appeared under BOTH Neutral and Satisfied with 2 sessions each,
    // and expanding either one listed all 4 in the cluster. The row said 2 and
    // the list said 4.
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [
          ...drilldownFixture().sessions,
          {
            _id: "sess-4",
            sentiment: "satisfied" as const,
            themeClusterId: "cluster-export",
            themeClusterLabel: "Export the board",
            outcome: "completed" as const,
          },
          {
            _id: "sess-5",
            sentiment: "satisfied" as const,
            themeClusterId: "cluster-export",
            themeClusterLabel: "Export the board",
            outcome: "completed" as const,
          },
        ],
        nextBefore: null,
        total: 4,
        totalTruncated: false,
      },
      isLoading: false,
    });
    mockUseQuery.mockReturnValue(null);

    render(<ScenarioFindingsTab scenarioId="scn-1" onOpenSession={vi.fn()} />);
    // Worst-first ordering puts frustrated/neutral ahead of satisfied, so the
    // default persona is the two frustrated sessions.
    await userEvent.click(await screen.findByTestId("findings-goal-row"));

    const listCall = mockUseGoalOutcomeDrilldown.mock.calls
      .map(([args]) => args as Record<string, unknown>)
      .findLast((args) => args.clusterId === "cluster-export");
    expect(listCall).toBeDefined();

    const filters = listCall!.filters as {
      chips: Array<Record<string, unknown>>;
    };
    // Scoped to this persona's sentiment, so the list can only return the
    // sessions the row counted.
    expect(filters.chips).toEqual(
      expect.arrayContaining([
        { kind: "dimension", key: "sentiment", value: "frustrated" },
      ]),
    );
    // And still hiding rehearsals, which is the policy it already carried.
    expect(filters.chips.length).toBeGreaterThan(1);
  });

  it("does not ask for a chain before a goal is opened", () => {
    mockUseQuery.mockReturnValue(null);

    render(<ScenarioFindingsTab scenarioId="scn-1" />);

    // One funnel per expand, paid by the reader who asked. Subscribing every
    // goal on open would buy a scan per cluster to paint rows nobody read.
    expect(mockUseQuery).not.toHaveBeenCalled();
  });
});

/**
 * The card is about ONE persona: its goal row counts that persona's sessions,
 * its session list shows them. The chain has to describe the same population
 * or the reader gets three numbers about two groups — which is exactly what
 * shipped, and showed up the day chains first derived as a card headed
 * "2 sessions" whose chain read "failed in 3 of 6 graded sessions".
 */
describe("the chain is scoped to the persona, not just the goal", () => {
  it("asks for the selected persona's sentiment alongside the goal", async () => {
    mockUseQuery.mockReturnValue(null);

    render(<ScenarioFindingsTab scenarioId="scn-1" />);
    await userEvent.click(await screen.findByTestId("findings-goal-row"));

    expect(mockUseQuery).toHaveBeenCalledWith(
      "chatSessionStageDerivation:getScenarioStageFunnel",
      {
        scenarioId: "scn-1",
        clusterId: "cluster-export",
        sentiment: "frustrated",
      },
    );
  });

  /** Two personas, both of whom tried the same goal. */
  function twoPersonaDrilldown() {
    return {
      ...drilldownFixture(),
      sessions: [
        ...drilldownFixture().sessions,
        {
          _id: "sess-9",
          sentiment: "satisfied" as const,
          themeClusterId: "cluster-export",
          themeClusterLabel: "Export the board",
          outcome: "completed" as const,
        },
      ],
      total: 3,
    };
  }

  const sentimentsAsked = () =>
    mockUseQuery.mock.calls
      .map(([, args]) => args as { sentiment?: string } | undefined)
      .filter((a) => a && "sentiment" in a)
      .map((a) => a!.sentiment);

  it("re-asks when the reader switches persona", async () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: twoPersonaDrilldown(),
      isLoading: false,
    });
    mockUseQuery.mockReturnValue(null);

    render(<ScenarioFindingsTab scenarioId="scn-1" />);
    await userEvent.click(await screen.findByTestId("findings-goal-row"));

    // Before the switch, only the first persona has been asked about.
    //
    // A FULL revert fails on the line below, not on the switch — with no
    // sentiment sent at all, `sentimentsAsked()` is empty. The switch is here
    // for the narrower regression the first half cannot see: a sentiment that
    // is sent once and then never re-sent when the reader changes persona.
    expect(sentimentsAsked()).toContain("frustrated");
    expect(sentimentsAsked()).not.toContain("satisfied");

    // Switching persona closes the open goal, so the reader reopens it.
    const tabs = await screen.findAllByTestId("findings-persona-tab");
    await userEvent.click(tabs[1]!);
    await userEvent.click(await screen.findByTestId("findings-goal-row"));

    // The same cluster under a different persona is a DIFFERENT population,
    // so it must be asked about separately rather than reusing the first
    // persona's answer.
    expect(sentimentsAsked()).toContain("satisfied");
  });

  it("paints the second persona's OWN chain, not a blank one", async () => {
    // Every other test here asserts an ABSENCE: that something was asked, or
    // that a stale chain is not painted. None of them would notice the most
    // likely regression — `sentiment` reaching the query while the answer's
    // identity stops matching the guard, which leaves persona two permanently
    // unmeasured. The staleness test below asserts blankness as the DESIRED
    // outcome, so it would call that bug a pass.
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: twoPersonaDrilldown(),
      isLoading: false,
    });
    // Built once, outside the implementation, for the identity reason this
    // file documents at the effect: a funnel minted per render spins forever.
    const frustratedFunnel = funnelOf(
      { connection: { passed: 2 }, discovery: { failed: 2 } },
      { counted: 2, total: 2, firstFailedStage: { discovery: 2 } },
    );
    const satisfiedFunnel = funnelOf(
      { connection: { failed: 1 }, discovery: { passed: 1 } },
      { counted: 1, total: 1, firstFailedStage: { connection: 1 } },
    );
    mockUseQuery.mockImplementation((_name: unknown, args: unknown) =>
      (args as { sentiment?: string }).sentiment === "frustrated"
        ? frustratedFunnel
        : satisfiedFunnel,
    );

    render(<ScenarioFindingsTab scenarioId="scn-1" />);
    await userEvent.click(await screen.findByTestId("findings-goal-row"));
    await waitFor(() =>
      expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
        "data-state",
        "fail",
      ),
    );

    const tabs = await screen.findAllByTestId("findings-persona-tab");
    await userEvent.click(tabs[1]!);
    await userEvent.click(await screen.findByTestId("findings-goal-row"));

    // Persona two's own chain, and it breaks somewhere else — so this cannot
    // pass by repainting persona one's answer OR by going blank.
    //
    // COMPLEMENTS the staleness test below rather than overlapping it: this
    // one resolves the second query immediately, so it cannot see the guard
    // being dropped; that one leaves it loading, which is the only window the
    // guard is for. Two regressions, two tests — do not fold them together.
    await waitFor(() =>
      expect(screen.getByTestId("findings-stage-connection")).toHaveAttribute(
        "data-state",
        "fail",
      ),
    );
    expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
      "data-state",
      "ok",
    );
  });

  it("never paints one persona with another persona's chain", async () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: twoPersonaDrilldown(),
      isLoading: false,
    });
    // Built ONCE, outside the implementation, for the reason the goal-axis
    // twin of this test gives: the chain effect keys on result identity and a
    // funnel minted per render would report forever.
    const frustratedFunnel = funnelOf(
      { connection: { passed: 2 }, discovery: { failed: 2 } },
      { counted: 2, total: 2, firstFailedStage: { discovery: 2 } },
    );
    // The first persona has an answer. The second is still loading, which is
    // the window a stale chain would show through.
    mockUseQuery.mockImplementation((_name: unknown, args: unknown) =>
      (args as { sentiment?: string }).sentiment === "frustrated"
        ? frustratedFunnel
        : undefined,
    );

    render(<ScenarioFindingsTab scenarioId="scn-1" />);
    await userEvent.click(await screen.findByTestId("findings-goal-row"));
    await waitFor(() =>
      expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
        "data-state",
        "fail",
      ),
    );

    const tabs = await screen.findAllByTestId("findings-persona-tab");
    await userEvent.click(tabs[1]!);
    await userEvent.click(await screen.findByTestId("findings-goal-row"));

    // Nobody has measured this goal for the satisfied persona yet. Showing the
    // frustrated persona's failure here would put a diagnosis on a population
    // it was never about — under a card headed with the other one's count.
    expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
      "data-state",
      "none",
    );
    expect(screen.getByTestId("findings-empty-stage")).toBeInTheDocument();
  });
});
