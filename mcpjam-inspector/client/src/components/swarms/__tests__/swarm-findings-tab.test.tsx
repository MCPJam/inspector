import { neverStartedReport } from "./swarm-report-fixtures";
import {
  brokenWire,
  WIRE_FIX_PHRASE,
  WIRE_MECHANISM_PHRASE,
  WIRE_GOAL,
  WIRE_PERSONA,
} from "./swarm-findings-wire-fixtures";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SwarmOverview,
  SwarmOverviewRun,
  SwarmWaveSignals,
} from "@/lib/swarm-api";
import { groupRunsIntoSwarmWaves } from "../swarm-overview-panel";
import {
  isLaunchFailuresUnavailable,
  SwarmFindingsTab,
} from "../findings/swarm-findings-tab";
import { reportBoundaryError, reportCaught } from "@/lib/error-reporting";
import { EMPTY_STAGE_COPY } from "../findings/findings-goal-inspect";
import { SwarmRunDetail } from "../swarm-run-detail";

/**
 * Two layers under test:
 *
 *  1. `SwarmFindingsTab` — the failing persona is selected by default with
 *     goals collapsed (expanding one lands on its diagnosis stage), the
 *     empty-stage copy refuses to read as a pass, sentiment is a pill only.
 *     Session click-through is opt-in (`projectId`); these tests omit it.
 *  2. `SwarmRunDetail` wiring — Findings sits beside Insights | Sessions (and
 *     Run, while the wave is live) and a `?tab=findings` deep link renders it.
 */

// ── Convex plumbing (SwarmRunDetail layer) ──────────────────────────────────

const NOW = 1_700_000_000_000;

function run(overrides: Partial<SwarmOverviewRun> = {}): SwarmOverviewRun {
  return {
    runId: "run-1",
    journeyRefId: "journey-1",
    journeyName: "Export the board",
    journeyArchived: false,
    personaName: "Maya Chen",
    createdAt: NOW,
    swarmRunGroupId: "wave-1",
    status: "completed",
    summary: { total: 4, succeeded: 4, failed: 0, rateLimited: 0 },
    findings: [],
    ...overrides,
  };
}

const failingRun = run({
  goalScoreSummary: { gradedCount: 4, passedCount: 1, avgScore: 0.2 },
});
const landedRun = run({
  runId: "run-2",
  journeyRefId: "journey-2",
  journeyName: "Open last week's board",
  personaName: "Jonah Okoye",
  goalScoreSummary: { gradedCount: 4, passedCount: 4, avgScore: 1 },
});

const overview: SwarmOverview = {
  runs: [failingRun, landedRun],
  runsConsidered: 2,
  goalCompletion: {
    gradedCount: 8,
    passedCount: 5,
    passRate: 5 / 8,
    runsWithGrades: 2,
    trend: [],
  },
};

const waveSignals: SwarmWaveSignals = {
  candidates: [
    {
      detector: "hallucinated_tool",
      subjectKind: "journey",
      subjectId: "journey-1",
      subjectLabel: "listSkills",
      affectedSessions: 2,
      sliceTotal: 3,
      exemplarSessionIds: ["sess-1"],
      contrastSessionIds: [],
      severityScore: 3,
    },
  ],
  sessionCount: 8,
  unanalyzedSessionCount: 0,
  judgeCoverage: { graded: 8, total: 8 },
  truncated: false,
  lowConfidence: false,
  terminal: true,
};

const { mockUseGoalOutcomeDrilldown, launchFailuresState } = vi.hoisted(() => ({
  mockUseGoalOutcomeDrilldown: vi.fn(() => ({
    drilldown: undefined,
    isLoading: false,
  })),
  // `journeyRuns:listRunLaunchFailures`: what it answers (a function of the
  // args, which may throw the way a real subscription does), and every args
  // object it was subscribed with.
  launchFailuresState: {
    value: undefined as unknown,
    calls: [] as unknown[],
  },
}));

vi.mock("@/lib/error-reporting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/error-reporting")>()),
  reportBoundaryError: vi.fn(),
  reportCaught: vi.fn(),
}));

vi.mock("@/hooks/useUsageInsights", () => ({
  useGoalOutcomeDrilldown: (...args: unknown[]) =>
    mockUseGoalOutcomeDrilldown(...args),
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "journeyRuns:getSwarmOverview":
        return overview;
      case "swarmWaveInsights:getWaveSignals":
        return waveSignals;
      case "journeyRuns:listRunLaunchFailures":
        launchFailuresState.calls.push(args);
        return typeof launchFailuresState.value === "function"
          ? (launchFailuresState.value as (a: unknown) => unknown)(args)
          : launchFailuresState.value;
      default:
        return undefined;
    }
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
}));

// The Insights/Sessions surfaces are heavy and not under test — stub them.
// (`run-insights` is gone since #5271; `signalSentence` lives beside the
// derivation module now and needs no stub.)
vi.mock("@/components/shared/usage-insights/InsightsWorkbench", () => ({
  InsightsWorkbench: () => <div data-testid="stub-insights-workbench" />,
}));
vi.mock("@/components/shared/actionable-insights/actionable-findings", () => ({
  ActionableFindings: ({
    surface,
    hideEmpty,
  }: {
    surface: { runId: string };
    hideEmpty?: boolean;
  }) => (
    <div
      data-testid="actionable-findings-mount"
      data-run-id={surface.runId}
      data-hide-empty={hideEmpty}
    />
  ),
}));
vi.mock("@/components/swarms/SwarmsSessionsPanel", () => ({
  SwarmsSessionsPanel: () => <div data-testid="stub-sessions-panel" />,
}));

const personas = [
  {
    _id: "persona-1",
    name: "Maya Chen",
    role: "Ops lead",
    avatarShape: 1,
    avatarPalette: 2,
  },
  { _id: "persona-2", name: "Jonah Okoye", role: "New hire" },
];

function renderDetail() {
  return render(
    <SwarmRunDetail
      swarmId="wave-1"
      projectId="proj-1"
      personas={personas}
      onRunAgain={vi.fn()}
    />,
  );
}

function wave() {
  return groupRunsIntoSwarmWaves(overview.runs)[0]!;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/swarms/wave-1");
});

afterEach(() => {
  vi.clearAllMocks();
  mockUseGoalOutcomeDrilldown.mockReturnValue({
    drilldown: undefined,
    isLoading: false,
  });
  launchFailuresState.value = undefined;
  launchFailuresState.calls = [];
});

// ── SwarmFindingsTab (pure props) ───────────────────────────────────────────

describe("SwarmFindingsTab", () => {
  it("defaults to the failing persona with goals collapsed; expanding lands on the diagnosis stage", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />,
    );
    // Maya's tab is selected (she has the failing goal).
    const tabs = screen.getAllByRole("tab");
    const maya = tabs.find((t) => t.textContent?.includes("Maya Chen"))!;
    expect(maya).toHaveAttribute("aria-selected", "true");
    // Goals start collapsed — the reader opens one to inspect it.
    expect(
      screen.queryByTestId("findings-goal-inspect"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    // The failing goal opens on its diagnosis stage.
    expect(screen.getByTestId("findings-goal-inspect")).toBeInTheDocument();
    expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Evidence phrases through the shared deterministic sentence.
    expect(screen.getByTestId("findings-stage-evidence").textContent).toContain(
      'Agents invented a tool named "listSkills"',
    );
  });

  it("keeps the chosen persona when a live wave adds one before her", () => {
    const { rerender } = render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />,
    );
    fireEvent.click(
      screen
        .getAllByRole("tab")
        .find((t) => t.textContent?.includes("Jonah Okoye"))!,
    );
    expect(
      within(screen.getByTestId("findings-persona-card")).getByText(
        "Jonah Okoye",
      ),
    ).toBeInTheDocument();

    // Personas sort by name, so "Ada" lands ahead of both — the old
    // index-keyed selection would have jumped to Jonah's neighbor.
    const withAda = groupRunsIntoSwarmWaves([
      ...overview.runs,
      run({
        runId: "run-3",
        journeyRefId: "journey-3",
        journeyName: "Invite a teammate",
        personaName: "Ada First",
      }),
    ])[0]!;
    rerender(
      <SwarmFindingsTab
        wave={withAda}
        waveSignals={waveSignals}
        personas={personas}
      />,
    );

    expect(
      within(screen.getByTestId("findings-persona-card")).getByText(
        "Jonah Okoye",
      ),
    ).toBeInTheDocument();
  });

  it("moves between stages with the arrow keys, one tab stop for the strip", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />,
    );
    fireEvent.click(screen.getByTestId("findings-goal-row"));

    const selected = screen.getByTestId("findings-stage-discovery");
    expect(selected).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("findings-stage-call")).toHaveAttribute(
      "tabindex",
      "-1",
    );

    fireEvent.keyDown(selected, { key: "ArrowRight" });
    expect(screen.getByTestId("findings-stage-selection")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(screen.getByTestId("findings-stage-selection"), {
      key: "Home",
    });
    expect(screen.getByTestId("findings-stage-connection")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(screen.getByTestId("findings-stage-connection"), {
      key: "End",
    });
    expect(screen.getByTestId("findings-stage-value")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders the verbatim empty-stage copy", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />,
    );
    // The call stage has no evidence in this fixture.
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    fireEvent.click(screen.getByTestId("findings-stage-call"));
    expect(screen.getByTestId("findings-empty-stage").textContent).toBe(
      EMPTY_STAGE_COPY,
    );
  });

  it("switches personas by tab", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />,
    );
    const jonahTab = screen
      .getAllByRole("tab")
      .find((t) => t.textContent?.includes("Jonah Okoye"))!;
    fireEvent.click(jonahTab);
    const panel = screen.getByTestId("findings-persona-card");
    expect(within(panel).getByText("Jonah Okoye")).toBeInTheDocument();
    // The panel shows Jonah's own diagnosis, not the previously selected
    // persona's — a real check on the swap, unlike a phrase the app never
    // renders.
    expect(panel.textContent).not.toContain("Maya Chen");
    expect(within(panel).getByTestId("findings-persona-meta").textContent).toBe(
      "New hire · 4 sessions",
    );
  });

  it("opens an exemplar session from an evidence row", () => {
    const onOpenSession = vi.fn();
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
        onOpenSession={onOpenSession}
      />,
    );
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    fireEvent.click(screen.getByTestId("findings-evidence-open-session"));
    expect(onOpenSession).toHaveBeenCalledWith("sess-1");
    expect(
      screen.queryByTestId("findings-goal-sessions"),
    ).not.toBeInTheDocument();
  });

  it("lists this goal's sessions for click-through when a project is in scope", () => {
    const onOpenSession = vi.fn();
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [
          {
            _id: "sess-a",
            firstMessagePreview: "Pull the proposal-stage prospects",
            lastActivityAt: NOW,
          },
        ],
        nextBefore: null,
        total: 4,
        totalTruncated: false,
      },
      isLoading: false,
    });
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
        onOpenSession={onOpenSession}
        projectId="proj-1"
      />,
    );
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    const whatHappened = screen.getByTestId("findings-stage-evidence");
    expect(
      within(whatHappened).getByTestId("findings-goal-sessions"),
    ).toBeInTheDocument();
    expect(
      within(whatHappened).getByTestId("findings-evidence-sessions-toggle"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("findings-goal-session"));
    expect(onOpenSession).toHaveBeenCalledWith("sess-a");
    expect(mockUseGoalOutcomeDrilldown).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          kind: "swarm",
          projectId: "proj-1",
          journeyRunIds: ["run-1"],
        },
      }),
    );
  });

  it("gives a single session a link rather than something to expand", () => {
    const onOpenSession = vi.fn();
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: {
        sessions: [
          {
            _id: "sess-only",
            firstMessagePreview: "Pull the proposal-stage prospects",
            lastActivityAt: NOW,
          },
        ],
        nextBefore: null,
        total: 1,
        totalTruncated: false,
      },
      isLoading: false,
    });
    const oneSession = run({
      summary: { total: 1, succeeded: 0, failed: 1, rateLimited: 0 },
      goalScoreSummary: { gradedCount: 1, passedCount: 0, avgScore: 0 },
    });
    render(
      <SwarmFindingsTab
        wave={groupRunsIntoSwarmWaves([oneSession])[0]!}
        waveSignals={waveSignals}
        personas={personas}
        onOpenSession={onOpenSession}
        projectId="proj-1"
      />,
    );
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    // The link is there; the expander is not.
    expect(screen.getByTestId("findings-goal-sessions")).toBeInTheDocument();
    expect(
      screen.queryByTestId("findings-evidence-sessions-toggle"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("findings-goal-session"));
    expect(onOpenSession).toHaveBeenCalledWith("sess-only");
  });

  it("offers no session control at all when the goal has no sessions", () => {
    mockUseGoalOutcomeDrilldown.mockReturnValue({
      drilldown: { sessions: [], nextBefore: null, total: 0 },
      isLoading: false,
    });
    const noSessions = run({
      summary: { total: 0, succeeded: 0, failed: 0, rateLimited: 0 },
    });
    render(
      <SwarmFindingsTab
        wave={groupRunsIntoSwarmWaves([noSessions])[0]!}
        waveSignals={waveSignals}
        personas={personas}
        onOpenSession={vi.fn()}
        projectId="proj-1"
      />,
    );
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    expect(
      screen.queryByTestId("findings-evidence-sessions-toggle"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("findings-goal-sessions"),
    ).not.toBeInTheDocument();
  });

  it("tells a finished legacy wave that it finished", () => {
    // No signals means no `terminal` flag, so the runs themselves have to say
    // it. Passing "unknown" here hid that the run was over.
    const { swarmRunGroupId: _drop, ...legacy } = run({
      status: "completed",
      summary: { total: 2, succeeded: 2, failed: 0, rateLimited: 0 },
    });
    render(
      <SwarmFindingsTab
        wave={groupRunsIntoSwarmWaves([legacy as SwarmOverviewRun])[0]!}
        waveSignals={null}
        personas={personas}
      />,
    );
    expect(screen.getByTestId("findings-summary").textContent).toContain(
      "This run finished with nothing graded.",
    );
  });

  it("survives a legacy wave with no signals (no crash)", () => {
    const legacyRuns = overview.runs.map((r) => {
      const { swarmRunGroupId: _drop, ...rest } = r;
      return rest as SwarmOverviewRun;
    });
    render(
      <SwarmFindingsTab
        wave={groupRunsIntoSwarmWaves(legacyRuns)[0]!}
        waveSignals={null}
        personas={personas}
      />,
    );
    expect(screen.getByTestId("swarm-findings-tab")).toBeInTheDocument();
    expect(screen.getByTestId("findings-summary-card")).toBeInTheDocument();
  });

  it("renders the finding summary above the persona picker", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />,
    );
    // ONE paragraph, in ONE element. The composer still answers the four
    // questions as separate sentences — goal, cause, persona, feeling — and
    // the card joins them, so the exact text is pinned here rather than in
    // fragments: a sentence that stopped being joined would still satisfy
    // every `toContain` while rendering as a stacked line again.
    const headline = screen.getByTestId("findings-headline");
    expect(headline.textContent).toBe(
      '"Export the board" broke at discovery for Maya Chen. Agents invented a tool named "listSkills" in 2 sessions. Maya Chen left lost.',
    );
    // The supporting sentences used to render as siblings BELOW the headline.
    // Asserting on the card's text would pass either way, so the check is that
    // the summary block holds nothing but that one heading.
    const summary = screen.getByTestId("findings-summary");
    expect(summary.children).toHaveLength(1);
    expect(summary.textContent).not.toContain("No findings yet");
    expect(screen.getByText(/Choose a persona/i)).toBeInTheDocument();
    // Same SectionLabel face as Finding summary / Goals they tried — not
    // body-ink 11px, which read as a different font from the muted kickers.
    for (const label of [
      screen.getByText(/Choose a persona/i),
      screen.getByText(/Finding summary/i),
      screen.getByText(/Goals they tried/i),
    ]) {
      expect(label.className.split(/\s+/)).toEqual(
        expect.arrayContaining([
          "text-xs",
          "font-semibold",
          "uppercase",
          "tracking-widest",
          "text-muted-foreground",
        ]),
      );
    }
  });

  it("promotes Lane A's narration to the headline", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
        generatedSummary="The main fix is to stop advertising listSkills. Update the tool guidance so"
      />,
    );
    // First complete sentence only: the backend stores a hard 320-char slice
    // that ends mid-clause.
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      "The main fix is to stop advertising listSkills.",
    );
    expect(screen.getByTestId("findings-headline").textContent).not.toContain(
      "broke at discovery",
    );
  });

  it("ellipsizes a narration the backend cut inside its first sentence", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
        generatedSummary="Resolve the saved server in the correct project and rejects host"
      />,
    );
    // No sentence boundary at all means the 320-char cut landed inside the
    // first sentence. It must never read as a finished thought.
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      "Resolve the saved server in the correct project and rejects host…",
    );
  });

  it("keeps the template headline when the narration is empty or absent", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
        generatedSummary="   "
      />,
    );
    expect(screen.getByTestId("findings-headline").textContent).toContain(
      '"Export the board" broke at discovery',
    );
  });

  it("refuses a narration of a wave that never launched", () => {
    // Lane A would be describing sessions that never existed. The template's
    // own answer is the only honest one here, so it wins.
    const deadRuns = [
      run({
        report: neverStartedReport(3),
        summary: { total: 3, succeeded: 0, failed: 3, rateLimited: 0 },
      }),
    ];
    render(
      <SwarmFindingsTab
        wave={groupRunsIntoSwarmWaves(deadRuns)[0]!}
        waveSignals={{ ...waveSignals, candidates: [] }}
        personas={personas}
        generatedSummary="The server handled every request cleanly."
      />,
    );
    const headline = screen.getByTestId("findings-headline");
    expect(headline.textContent).toContain("3 of 3 sessions failed to launch.");
    expect(headline.textContent).toContain(
      "Nothing about the server was tested.",
    );
    // A model that read no sessions has nothing to suggest about them.
    expect(screen.getByTestId("swarm-findings-tab").textContent).not.toContain(
      "handled every request",
    );
  });

  /**
   * #5188: the summary could count the refused sessions but never say why,
   * which is how "one endpoint returned 400 on every turn" read as a finding
   * about the server under test for three days.
   */
  describe("why sessions didn't run", () => {
    const deadWave = () =>
      groupRunsIntoSwarmWaves([
        run({
          report: neverStartedReport(3),
          summary: { total: 3, succeeded: 0, failed: 3, rateLimited: 0 },
        }),
      ])[0]!;

    it("names the refusal the attempts recorded", () => {
      launchFailuresState.value = [
        {
          runId: "run-1",
          sessionsNotRun: 3,
          sessionsTotal: 3,
          reasons: [
            {
              errorCode: "session_failed",
              errorMessage: "Persona turn failed: 400 invalid identity",
              count: 3,
            },
          ],
        },
      ];
      render(
        <SwarmFindingsTab
          wave={deadWave()}
          waveSignals={{ ...waveSignals, candidates: [] }}
          personas={personas}
        />,
      );

      // Subscribed with the wave's runs (once per render, same args).
      expect(launchFailuresState.calls.length).toBeGreaterThan(0);
      for (const args of launchFailuresState.calls)
        expect(args).toEqual({ journeyRunIds: ["run-1"] });
      const reason = screen.getByTestId("findings-launch-reason");
      expect(reason).toHaveTextContent("Why sessions didn't run");
      expect(reason).toHaveTextContent(/invalid identity/i);
      // The count stays where it was.
      expect(screen.getByTestId("findings-headline").textContent).toContain(
        "3 of 3 sessions failed to launch.",
      );
    });

    // What `useQuery` throws for a function the deployment does not serve:
    // the DEV shape, and the redacted form production turns it into.
    const NOT_DEPLOYED = new Error(
      "[CONVEX Q(journeyRuns:listRunLaunchFailures)] [Request ID: 1] Server Error\n" +
        "Could not find public function for 'journeyRuns:listRunLaunchFailures'. " +
        "Did you forget to run `npx convex dev`?",
    );
    const REDACTED = new Error(
      "[CONVEX Q(journeyRuns:listRunLaunchFailures)] [Request ID: 2] Server Error",
    );
    const REFUSED = new Error(
      "[CONVEX Q(journeyRuns:listRunLaunchFailures)] [Request ID: 3] " +
        "journeyRunIds names 101 runs; at most 100 may be read at once",
    );
    const failuresFor = (runId: string) => [
      {
        runId,
        sessionsNotRun: 3,
        sessionsTotal: 3,
        reasons: [
          {
            errorCode: "session_failed",
            errorMessage: `Persona turn failed for ${runId}: 400 invalid identity`,
            count: 3,
          },
        ],
      },
    ];
    const deadWaveOf = (runId: string) =>
      groupRunsIntoSwarmWaves([
        run({
          runId,
          journeyRefId: `journey-${runId}`,
          report: neverStartedReport(3),
          summary: { total: 3, succeeded: 0, failed: 3, rateLimited: 0 },
        }),
      ])[0]!;
    const renderTab = (w: ReturnType<typeof deadWaveOf>) => (
      <SwarmFindingsTab
        wave={w}
        waveSignals={{ ...waveSignals, candidates: [] }}
        personas={personas}
      />
    );

    it("leaves the summary intact, and files nothing, on a backend without the query", () => {
      launchFailuresState.value = () => {
        throw NOT_DEPLOYED;
      };
      render(renderTab(deadWave()));

      expect(screen.getByTestId("findings-headline").textContent).toContain(
        "3 of 3 sessions failed to launch.",
      );
      expect(
        screen.queryByTestId("findings-launch-reason"),
      ).not.toBeInTheDocument();
      // The dark ship is the state this read is built to sit in, on a page
      // opened again and again: it must not file an error each time.
      expect(reportBoundaryError).not.toHaveBeenCalled();
      expect(reportCaught).not.toHaveBeenCalled();
    });

    it("keeps the redacted form off the error path, with one info report per page load", () => {
      // Redacted, it could be the dark ship or a real crash. Not an error on
      // every visit, but not invisible either.
      launchFailuresState.value = () => {
        throw REDACTED;
      };
      const { unmount } = render(renderTab(deadWave()));
      unmount();
      render(renderTab(deadWaveOf("run-z")));

      expect(reportBoundaryError).not.toHaveBeenCalled();
      expect(reportCaught).toHaveBeenCalledTimes(1);
      expect(reportCaught).toHaveBeenCalledWith(REDACTED, {
        source: "swarm_launch_failures_redacted",
        level: "info",
      });
    });

    it("still reports a failure it does not expect", () => {
      launchFailuresState.value = () => {
        throw REFUSED;
      };
      render(renderTab(deadWave()));

      expect(
        screen.queryByTestId("findings-launch-reason"),
      ).not.toBeInTheDocument();
      expect(reportBoundaryError).toHaveBeenCalledTimes(1);
    });

    it("tells the dark-ship shapes of this query from everything else", () => {
      expect(isLaunchFailuresUnavailable(NOT_DEPLOYED)).toBe(true);
      expect(isLaunchFailuresUnavailable(REDACTED)).toBe(true);
      expect(isLaunchFailuresUnavailable(REFUSED)).toBe(false);
      // Another query's redacted failure is not this one's to swallow.
      expect(
        isLaunchFailuresUnavailable(
          new Error(
            "[CONVEX Q(journeyRuns:getJourneyRun)] [Request ID: 4] Server Error",
          ),
        ),
      ).toBe(false);
    });

    it("reads the next wave's reason after one read failed", () => {
      // The boundary is keyed to the wave: a failed read for one wave must
      // not leave the line off every wave the tab shows after it.
      launchFailuresState.value = (args: { journeyRunIds: string[] }) => {
        if (args.journeyRunIds.includes("run-a")) throw REFUSED;
        return failuresFor("run-b");
      };
      const { rerender } = render(renderTab(deadWaveOf("run-a")));
      expect(
        screen.queryByTestId("findings-launch-reason"),
      ).not.toBeInTheDocument();

      rerender(renderTab(deadWaveOf("run-b")));
      expect(screen.getByTestId("findings-launch-reason")).toHaveTextContent(
        "run-b",
      );
    });

    it("never shows one wave's reason on the next while its read is in flight", () => {
      // `SwarmRunDetail` does not remount the tab between waves, so the
      // stored reason is keyed to the runs it was read for.
      launchFailuresState.value = (args: { journeyRunIds: string[] }) =>
        args.journeyRunIds.includes("run-a") ? failuresFor("run-a") : undefined;
      const { rerender } = render(renderTab(deadWaveOf("run-a")));
      expect(screen.getByTestId("findings-launch-reason")).toHaveTextContent(
        "run-a",
      );

      rerender(renderTab(deadWaveOf("run-b")));
      expect(
        screen.queryByTestId("findings-launch-reason"),
      ).not.toBeInTheDocument();
    });

    it("asks nothing of a published wave whose sessions all started", () => {
      const journeyFindings = brokenWire();
      journeyFindings.population = {
        ...journeyFindings.population,
        configured: 3,
        started: 3,
        limited: 0,
      };
      render(
        <SwarmFindingsTab
          wave={wave()}
          waveSignals={waveSignals}
          personas={personas}
          journeyFindings={journeyFindings}
        />,
      );

      expect(launchFailuresState.calls).toEqual([]);
    });

    it("names the refusal on a published wave where some sessions did not start", () => {
      launchFailuresState.value = failuresFor("run-1");
      const journeyFindings = brokenWire();
      journeyFindings.population = {
        ...journeyFindings.population,
        configured: 3,
        started: 1,
        limited: 0,
      };
      render(
        <SwarmFindingsTab
          wave={wave()}
          waveSignals={waveSignals}
          personas={personas}
          journeyFindings={journeyFindings}
        />,
      );

      expect(launchFailuresState.calls.length).toBeGreaterThan(0);
      expect(screen.getByTestId("findings-launch-reason")).toHaveTextContent(
        /invalid identity/i,
      );
    });

    it("asks nothing of a wave whose sessions all started", () => {
      render(
        <SwarmFindingsTab
          wave={wave()}
          waveSignals={waveSignals}
          personas={personas}
        />,
      );

      expect(launchFailuresState.calls).toEqual([]);
      expect(
        screen.queryByTestId("findings-launch-reason"),
      ).not.toBeInTheDocument();
    });
  });
});

// ── SwarmRunDetail wiring ───────────────────────────────────────────────────

describe("SwarmRunDetail findings wiring", () => {
  it("offers the Findings tab beside Run | Insights | Sessions and renders it on ?tab=findings", () => {
    window.history.replaceState({}, "", "/swarms/wave-1?tab=findings");
    renderDetail();
    const nav = screen.getByRole("navigation", { name: "Swarm run view" });
    expect(
      within(nav).getByRole("button", { name: "Run" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("button", { name: "Findings" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("swarm-findings-tab")).toBeInTheDocument();
    expect(screen.getByTestId("swarm-run-detail-state")).toBeInTheDocument();
    expect(
      screen.queryByTestId("stub-insights-workbench"),
    ).not.toBeInTheDocument();
  });

  it("still lands on Findings by default", () => {
    renderDetail();
    expect(screen.getByTestId("swarm-findings-tab")).toBeInTheDocument();
    expect(screen.getByTestId("swarm-run-detail-state")).toBeInTheDocument();
    expect(
      screen.queryByTestId("stub-insights-workbench"),
    ).not.toBeInTheDocument();
  });

  it("keeps Sessions as the conversation browser", () => {
    window.history.replaceState({}, "", "/swarms/wave-1?tab=sessions");
    renderDetail();
    expect(screen.getByTestId("stub-sessions-panel")).toBeInTheDocument();
    expect(screen.queryByLabelText("Swarm report")).not.toBeInTheDocument();
    expect(screen.queryByTestId("swarm-findings-tab")).not.toBeInTheDocument();
  });
});

describe("SwarmFindingsTab on shared findings", () => {
  // PLB-29: the tab ends at the persona cards. The actionable-findings list
  // ("Fix in your MCP server" and the rest) must not render below them.
  it("renders backend findings without the actionable-findings list", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={null}
        personas={personas}
        projectId="proj-1"
        journeyFindings={brokenWire()}
      />,
    );
    expect(
      screen.getByRole("tab", { name: new RegExp(WIRE_PERSONA.name) }),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("actionable-findings-mount"),
    ).not.toBeInTheDocument();
  });

  it("names the cause and shows its fix on its own line", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={null}
        personas={personas}
        journeyFindings={brokenWire()}
        generatedSummary="Lane A prose that must not win."
      />,
    );
    // The cause leads; the fix is beside it, not instead of it. Lane A's prose
    // still loses to the shared pipeline on this path.
    const headline = screen.getByTestId("findings-headline").textContent;
    expect(headline).toContain(WIRE_MECHANISM_PHRASE.replace(/\.$/, ""));
    expect(headline).not.toContain("Lane A prose");
    expect(screen.getByTestId("findings-summary").textContent).not.toContain(
      "Suggested fix",
    );
    const fix = screen.getByTestId("findings-suggested-fix").textContent;
    expect(fix).toContain(WIRE_FIX_PHRASE);
    expect(fix).toContain("Suggested fix");
  });

  it("names the goal, stage and persona when there is no fix to promote", () => {
    const wire = brokenWire();
    wire.findings = wire.findings.map((row) => ({ ...row, fixPhrase: null }));
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={null}
        personas={personas}
        journeyFindings={wire}
      />,
    );
    const headline = screen.getByTestId("findings-headline").textContent;
    expect(headline).toContain(WIRE_MECHANISM_PHRASE.replace(/\.$/, ""));
    expect(headline).toContain(WIRE_GOAL.title);
    expect(headline).toContain(WIRE_PERSONA.name);
    expect(headline).not.toContain("Some goals were blocked.");
    // No fix on the cause means no fix shown — never another cause's.
    expect(screen.getByTestId("findings-summary").textContent).not.toContain(
      "Suggested fix",
    );
  });

  it.each([
    ["pending", "Reading session evidence…"],
    ["failed", "Session analysis did not complete."],
    ["skipped", "Session analysis was skipped."],
  ] as const)("states a %s analysis job", (status, copy) => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
        journeyFindingsJob={{ status, updatedAt: 0 }}
      />,
    );
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it("says nothing about a completed analysis job", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
        journeyFindings={brokenWire()}
        journeyFindingsJob={{ status: "completed", updatedAt: 0 }}
      />,
    );
    expect(
      screen.queryByText("Reading session evidence…"),
    ).not.toBeInTheDocument();
  });

  it("keeps the empty state when there is no persona and no wire payload", () => {
    render(
      <SwarmFindingsTab
        wave={{ ...wave(), runs: [] }}
        waveSignals={null}
        personas={personas}
      />,
    );
    expect(screen.getByTestId("findings-empty").textContent).toContain(
      "No sessions in this swarm run.",
    );
    expect(
      screen.queryByTestId("findings-summary-card"),
    ).not.toBeInTheDocument();
  });

  it("still states a wire summary when the wire names no persona", () => {
    const wire = brokenWire();
    wire.personas = [];
    wire.findings = [];
    wire.summaryKind = "notLaunched";
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={null}
        personas={personas}
        journeyFindings={wire}
      />,
    );
    expect(screen.queryByTestId("findings-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      "No sessions launched.",
    );
  });
});
