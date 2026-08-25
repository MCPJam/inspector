import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
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
 *  1. `SwarmFindingsTab` — pure props, no convex: defaults land on the
 *     trouble (failing persona → failing goal → diagnosis stage), the
 *     empty-stage copy refuses to read as a pass, sentiment is a pill only.
 *  2. `SwarmRunDetail` gating — the PostHog flag is the only thing that
 *     makes the tab exist: flag off means no tab option AND `?tab=findings`
 *     lands on Insights.
 */

// ── Flag + convex plumbing (SwarmRunDetail layer) ───────────────────────────

let findingsFlagEnabled: boolean | undefined = true;
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => findingsFlagEnabled,
}));

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
  usePaginatedQuery: () => ({
    results: [],
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
    RunInsightsProvider: ({ children }: { children?: React.ReactNode }) => (
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
      onOpenPersona={vi.fn()}
    />
  );
}

function wave() {
  return groupRunsIntoSwarmWaves(overview.runs)[0]!;
}

beforeEach(() => {
  findingsFlagEnabled = true;
  window.history.replaceState({}, "", "/swarms/wave-1");
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── SwarmFindingsTab (pure props) ───────────────────────────────────────────

describe("SwarmFindingsTab", () => {
  it("defaults to the failing persona, its failing goal, and the diagnosis stage", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />
    );
    expect(screen.getByTestId("findings-headline").textContent).toContain(
      `Maya Chen's "Export the board" broke at discovery`
    );
    // Maya's tab is selected (she has the failing goal).
    const tabs = screen.getAllByRole("tab");
    const maya = tabs.find((t) => t.textContent?.includes("Maya Chen"))!;
    expect(maya).toHaveAttribute("aria-selected", "true");
    // Her failing goal auto-expanded on the diagnosis stage.
    expect(screen.getByTestId("findings-goal-inspect")).toBeInTheDocument();
    expect(screen.getByTestId("findings-stage-discovery")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    // Evidence phrases through the shared deterministic sentence.
    expect(screen.getByTestId("findings-stage-evidence").textContent).toContain(
      'Agents invented a tool named "listSkills"'
    );
  });

  it("renders the verbatim empty-stage copy and the do-not-infer-pass legend", () => {
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
      />
    );
    // The call stage has no evidence in this fixture.
    fireEvent.click(screen.getByTestId("findings-stage-call"));
    expect(screen.getByTestId("findings-empty-stage").textContent).toBe(
      EMPTY_STAGE_COPY
    );
    expect(screen.getByTestId("findings-legend").textContent).toContain(
      "No finding · do not infer pass"
    );
  });

  it("switches personas by tab and shows the pill-only sentiment with its disclaimer", () => {
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
    expect(panel.textContent).toContain("not a score for the person");
    expect(within(panel).getByTestId("findings-persona-meta").textContent).toBe(
      "New hire · Authored · 4 sessions"
    );
    // Jonah landed — pill says Relieved, and no card wash exists (tone lives
    // on the pill element only).
    const pills = within(panel).getAllByTestId("findings-sentiment-pill");
    expect(pills.some((p) => p.textContent === "Relieved")).toBe(true);
  });

  it("opens an exemplar session from an evidence row", () => {
    const onOpenSession = vi.fn();
    render(
      <SwarmFindingsTab
        wave={wave()}
        waveSignals={waveSignals}
        personas={personas}
        onOpenSession={onOpenSession}
      />
    );
    fireEvent.click(screen.getByTestId("findings-evidence-open-session"));
    expect(onOpenSession).toHaveBeenCalledWith("sess-1");
  });

  it("survives a legacy wave with no signals (rubric-only footnote, no crash)", () => {
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
    expect(screen.getByTestId("findings-footnotes").textContent).toContain(
      "Rubric findings only"
    );
  });
});

// ── SwarmRunDetail flag gating ──────────────────────────────────────────────

describe("SwarmRunDetail findings gating", () => {
  it("shows the Findings tab and renders it on ?tab=findings when the flag is on", () => {
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

  it("hides the tab and coerces ?tab=findings to Insights when the flag is off", () => {
    findingsFlagEnabled = undefined; // loading OR missing — both fail closed
    window.history.replaceState({}, "", "/swarms/wave-1?tab=findings");
    renderDetail();
    const nav = screen.getByRole("navigation", { name: "Swarm run view" });
    expect(
      within(nav).queryByRole("button", { name: "Findings" })
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("swarm-findings-tab")).not.toBeInTheDocument();
    expect(screen.getByTestId("stub-insights-workbench")).toBeInTheDocument();
  });
});
