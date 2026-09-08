import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import type {
  JourneySessionRow,
  SwarmOverview,
  SwarmOverviewRun,
  SwarmWaveSignals,
} from "@/lib/swarm-api";
import { groupRunsIntoSwarmWaves } from "../swarm-overview-panel";
import { SwarmFindingsTab } from "../findings/swarm-findings-tab";
import { EMPTY_STAGE_COPY } from "../findings/findings-goal-inspect";
import { SwarmRunDetail } from "../swarm-run-detail";

/**
 * Two layers under test:
 *
 *  1. `SwarmFindingsTab` — the failing persona is selected by default with
 *     goals collapsed (expanding one lands on its diagnosis stage), the
 *     empty-stage copy refuses to read as a pass, sentiment is a pill only.
 *     Session click-through is opt-in (`onOpenSession`) and scoped to the
 *     EVIDENCE, so a stage never lists its goal.
 *  2. `SwarmRunDetail` wiring — Findings sits beside Insights | Sessions and
 *     a `?tab=findings` deep link renders it.
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

/** Rows `journeyRuns:listSessionsByJourneyRun` hands the evidence list. */
let runSessions: JourneySessionRow[] = [];

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "journeyRuns:getSwarmOverview":
        return overview;
      case "swarmWaveInsights:getWaveSignals":
        return waveSignals;
      default:
        return undefined;
    }
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  usePaginatedQuery: (name: string) => ({
    results: name === "journeyRuns:listSessionsByJourneyRun" ? runSessions : [],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
}));

// The Insights/Sessions surfaces are heavy and not under test — stub them,
// keeping the run-insights helpers the derivation module reuses.
vi.mock("@/components/shared/usage-insights/InsightsWorkbench", () => ({
  InsightsWorkbench: () => <div data-testid="stub-insights-workbench" />,
}));
vi.mock("@/components/shared/usage-insights/run-insights", async (orig) => {
  const actual = await orig<
    typeof import("@/components/shared/usage-insights/run-insights")
  >();
  return {
    ...actual,
    RunInsightsProvider: ({ children }: { children?: ReactNode }) => (
      <>{children}</>
    ),
    RunInsightsRecommendations: () => null,
  };
});
vi.mock("@/components/shared/actionable-insights/actionable-findings", () => ({
  ActionableFindings: () => null,
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
    />
  );
}

function wave() {
  return groupRunsIntoSwarmWaves(overview.runs)[0]!;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/swarms/wave-1");
  runSessions = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── SwarmFindingsTab (pure props) ───────────────────────────────────────────

describe("SwarmFindingsTab", () => {
  it("defaults to the failing persona with goals collapsed; expanding lands on the diagnosis stage", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />
    );
    // Maya's tab is selected (she has the failing goal).
    const tabs = screen.getAllByRole("tab");
    const maya = tabs.find((t) => t.textContent?.includes("Maya Chen"))!;
    expect(maya).toHaveAttribute("aria-selected", "true");
    // Goals start collapsed — the reader opens one to inspect it.
    expect(
      screen.queryByTestId("findings-goal-inspect")
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    // The failing goal opens on its diagnosis stage.
    expect(screen.getByTestId("findings-goal-inspect")).toBeInTheDocument();
    expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    // Evidence phrases through the shared deterministic sentence.
    expect(screen.getByTestId("findings-stage-evidence").textContent).toContain(
      'Agents invented a tool named "listSkills"'
    );
  });

  it("keeps the chosen persona when a live wave adds one before her", () => {
    const { rerender } = render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />
    );
    fireEvent.click(
      screen.getAllByRole("tab").find((t) =>
        t.textContent?.includes("Jonah Okoye")
      )!
    );
    expect(
      within(screen.getByTestId("findings-persona-card")).getByText(
        "Jonah Okoye"
      )
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
      />
    );

    expect(
      within(screen.getByTestId("findings-persona-card")).getByText(
        "Jonah Okoye"
      )
    ).toBeInTheDocument();
  });

  it("moves between stages with the arrow keys, one tab stop for the strip", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />
    );
    fireEvent.click(screen.getByTestId("findings-goal-row"));

    const selected = screen.getByTestId("findings-stage-discovery");
    expect(selected).toHaveAttribute("tabindex", "0");
    expect(screen.getByTestId("findings-stage-call")).toHaveAttribute(
      "tabindex",
      "-1"
    );

    fireEvent.keyDown(selected, { key: "ArrowRight" });
    expect(screen.getByTestId("findings-stage-selection")).toHaveAttribute(
      "aria-selected",
      "true"
    );

    fireEvent.keyDown(screen.getByTestId("findings-stage-selection"), {
      key: "Home",
    });
    expect(screen.getByTestId("findings-stage-connection")).toHaveAttribute(
      "aria-selected",
      "true"
    );

    fireEvent.keyDown(screen.getByTestId("findings-stage-connection"), {
      key: "End",
    });
    expect(screen.getByTestId("findings-stage-value")).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("renders the verbatim empty-stage copy", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />
    );
    // The call stage has no evidence in this fixture.
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    fireEvent.click(screen.getByTestId("findings-stage-call"));
    expect(screen.getByTestId("findings-empty-stage").textContent).toBe(
      EMPTY_STAGE_COPY
    );
  });

  it("switches personas by tab", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />
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
      "New hire · 4 sessions"
    );
  });

  it("prints the denominator flat with no session affordance when opening is off", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />
    );
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    expect(
      screen.queryByTestId("findings-evidence-sessions-toggle")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("findings-evidence-sessions")
    ).not.toBeInTheDocument();
  });

  it("lists the sessions the evidence names, and admits a bounded sample", () => {
    const onOpenSession = vi.fn();
    runSessions = [
      {
        id: "sess-1",
        chatSessionId: "chat-1",
        projectId: "proj-1",
        hostId: "host-1",
        startedAt: NOW,
        firstMessagePreview: "Pull the proposal-stage prospects",
      },
    ];
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
        onOpenSession={onOpenSession}
      />
    );
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    const whatHappened = screen.getByTestId("findings-stage-evidence");

    // The detector named 1 of the 2 sessions it affected, so the label says
    // so rather than putting one row under a claim of two.
    expect(
      within(whatHappened).getByTestId("findings-evidence-sessions-toggle")
        .textContent
    ).toContain("2 of 3 sessions · 1 shown");

    const list = within(whatHappened).getByTestId(
      "findings-evidence-sessions"
    );
    expect(list.dataset.scope).toBe("ids");
    const rows = within(list).getAllByTestId("findings-evidence-session");
    expect(rows.map((r) => r.dataset.sessionId)).toEqual(["sess-1"]);
    fireEvent.click(rows[0]!);
    expect(onOpenSession).toHaveBeenCalledWith("sess-1");
  });

  it("offers no session list on a stage with no finding", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
        onOpenSession={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    // The call stage has no evidence in this fixture. A list here would read
    // as "here is what got through" — the inference the copy refuses.
    fireEvent.click(screen.getByTestId("findings-stage-call"));
    expect(screen.getByTestId("findings-empty-stage")).toBeInTheDocument();
    expect(
      screen.queryByTestId("findings-evidence-sessions-toggle")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("findings-evidence-sessions")
    ).not.toBeInTheDocument();
  });

  it("gives each stage its own session scope, not one goal-wide list", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
        onOpenSession={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("findings-goal-row"));
    // Discovery carries the detector's exemplars; User Value carries the
    // judge's failed grades. Same goal, different sets.
    expect(
      screen.getByTestId("findings-evidence-sessions").dataset.scope
    ).toBe("ids");
    fireEvent.click(screen.getByTestId("findings-stage-value"));
    expect(
      screen.getByTestId("findings-evidence-sessions").dataset.scope
    ).toBe("goalScoreFail");
    // Connection only ever holds launch outcomes, which have no transcript.
    fireEvent.click(screen.getByTestId("findings-stage-connection"));
    expect(
      screen.queryByTestId("findings-evidence-sessions-toggle")
    ).not.toBeInTheDocument();
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
      />
    );
    expect(screen.getByTestId("swarm-findings-tab")).toBeInTheDocument();
    expect(screen.getByTestId("findings-summary-card")).toBeInTheDocument();
    expect(screen.getByTestId("findings-footnotes").textContent).toContain(
      "Rubric findings only"
    );
  });

  it("renders the finding summary headline above the persona picker", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />
    );
    expect(screen.getByTestId("findings-headline").textContent).toBe(
      '"Export the board" broke at discovery.'
    );
    expect(screen.getByText(/Choose a persona/i)).toBeInTheDocument();
  });
});

// ── SwarmRunDetail wiring ───────────────────────────────────────────────────

describe("SwarmRunDetail findings wiring", () => {
  it("offers the Findings tab beside Insights | Sessions and renders it on ?tab=findings", () => {
    window.history.replaceState({}, "", "/swarms/wave-1?tab=findings");
    renderDetail();
    const nav = screen.getByRole("navigation", { name: "Swarm run view" });
    expect(
      within(nav).getByRole("button", { name: "Findings" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("swarm-findings-tab")).toBeInTheDocument();
    expect(
      screen.queryByTestId("stub-insights-workbench")
    ).not.toBeInTheDocument();
  });

  it("still lands on Findings by default", () => {
    renderDetail();
    expect(screen.getByTestId("swarm-findings-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-insights-workbench")).not.toBeInTheDocument();
  });
});
