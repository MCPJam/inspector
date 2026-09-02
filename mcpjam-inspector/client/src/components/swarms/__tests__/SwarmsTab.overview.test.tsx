import {
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  JourneySessionRow,
  SwarmOverview,
  SwarmOverviewRun,
  SwarmWaveSignals,
} from "@/lib/swarm-api";
import {
  SWARM_COLUMN_HEADER,
  filterAndSortSwarmWaves,
  groupRunsIntoSwarmWaves,
  waveLiveProgress,
} from "../swarm-overview-panel";

/**
 * The Swarms OVERVIEW tab — the default landing view.
 *
 * Two things these tests are actually for:
 *
 *  1. The WIRE CONTRACT. The Overview read is string-keyed and cast through
 *     `as any`, so nothing type-checks the call. Every query dispatch is
 *     recorded and asserted by (name, args) — a renamed query or a renamed arg
 *     would otherwise only show up as a blank tab in production.
 *  2. The FIXTURE CONTRACT. The fixtures below are typed against the mirrored
 *     `SwarmOverview` interfaces, so a backend field rename that reaches the
 *     mirror forces an edit here. Untyped fixtures would keep rendering — as
 *     `NaN%` and "undefined of undefined sessions".
 */

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

const NOW = Date.now();

const persona = {
  _id: "persona-1",
  personaId: "p1",
  name: "Persona One",
  role: "tester",
  notes: "",
};

/**
 * Two journey-runs launched together (same New swarm wave), plus an older
 * solo re-run of the same journey and an archived journey far in the past.
 */
const overview: SwarmOverview = {
  // Newest-first — mirrors `getSwarmOverview`'s page order.
  runs: [
    {
      // Same wave as run-2 — landed a few seconds later in the fan-out.
      runId: "run-2b",
      journeyRefId: "journey-2",
      journeyName: "Invoice lookup",
      journeyArchived: false,
      personaName: "Persona Two",
      createdAt: NOW - 55_000,
      status: "completed",
      summary: { total: 5, succeeded: 5, failed: 0, rateLimited: 0 },
      goalScoreSummary: {
        gradedCount: 4,
        passedCount: 4,
        avgScore: 1,
        pendingCount: 0,
        failedCount: 0,
      },
      findings: [],
      targets: [
        {
          hostName: "Claude",
          modelId: "anthropic/claude-haiku-4.5",
          environmentName: "Prod · Claude",
        },
      ],
    },
    {
      runId: "run-2",
      journeyRefId: "journey-1",
      journeyName: "Refund flow",
      journeyArchived: false,
      personaName: "Persona One",
      createdAt: NOW - 60_000,
      status: "completed",
      summary: { total: 15, succeeded: 15, failed: 0, rateLimited: 0 },
      goalScoreSummary: {
        gradedCount: 6,
        passedCount: 3,
        avgScore: 0.62,
        pendingCount: 0,
        failedCount: 0,
      },
      findings: [
        {
          criterionId: "crit-quick",
          label: "Quick resolution",
          kind: "turnCountUnder",
          failCount: 4,
          pendingCount: 9,
          failedGradingCount: 0,
          sessionsGraded: 6,
          runStreak: 2,
        },
        {
          criterionId: "crit-search",
          kind: "toolCalledAtLeastOnce",
          failCount: 1,
          pendingCount: 0,
          failedGradingCount: 0,
          sessionsGraded: 6,
          runStreak: 1,
        },
      ],
      targets: [
        {
          hostName: "Cursor",
          modelId: "openai/gpt-4o-mini",
        },
      ],
    },
    {
      runId: "run-1",
      journeyRefId: "journey-1",
      journeyName: "Refund flow",
      journeyArchived: false,
      personaName: "Persona One",
      createdAt: NOW - 7_200_000,
      status: "partial",
      summary: { total: 15, succeeded: 12, failed: 3, rateLimited: 0 },
      goalScoreSummary: {
        gradedCount: 10,
        passedCount: 4,
        avgScore: 0.4,
        pendingCount: 0,
        failedCount: 0,
      },
      findings: [],
      targets: [
        {
          hostName: "Claude",
          modelId: "anthropic/claude-haiku-4.5",
        },
      ],
    },
    {
      runId: "run-old",
      journeyRefId: "journey-archived",
      journeyName: "Retired flow",
      journeyArchived: true,
      personaName: "Persona One",
      createdAt: NOW - 90_000_000,
      status: "completed",
      summary: { total: 2, succeeded: 2, failed: 0, rateLimited: 0 },
      findings: [],
      targets: [],
    },
  ],
  runsConsidered: 4,
  goalCompletion: {
    gradedCount: 20,
    passedCount: 11,
    passRate: 11 / 20,
    runsWithGrades: 3,
    trend: [],
  },
};

/** Two graded sessions on run-2: one failed `crit-quick`, one passed it. */
const runSessions: JourneySessionRow[] = [
  {
    id: "thread-fail",
    chatSessionId: "synth_run-2_host-1_0",
    projectId: "proj-1",
    hostId: "host-1",
    personaRefId: "persona-1",
    journeyRunId: "run-2",
    journeyRefId: "journey-1",
    startedAt: 1,
    messageCount: 4,
    firstMessagePreview: "I want my money back",
    personaLabel: "Persona One",
    criteria: {
      status: "completed",
      generation: 1,
      results: [
        { criterionId: "crit-quick", passed: false },
        { criterionId: "crit-search", passed: true },
      ],
    },
  },
  {
    id: "thread-pass",
    chatSessionId: "synth_run-2_host-1_1",
    projectId: "proj-1",
    hostId: "host-1",
    personaRefId: "persona-1",
    journeyRunId: "run-2",
    journeyRefId: "journey-1",
    startedAt: 2,
    messageCount: 3,
    firstMessagePreview: "refund please",
    personaLabel: "Persona One",
    criteria: {
      status: "completed",
      generation: 1,
      results: [
        { criterionId: "crit-quick", passed: true },
        { criterionId: "crit-search", passed: true },
      ],
    },
  },
  {
    id: "thread-pending",
    chatSessionId: "synth_run-2_host-1_2",
    projectId: "proj-1",
    hostId: "host-1",
    journeyRunId: "run-2",
    journeyRefId: "journey-1",
    startedAt: 3,
    messageCount: 2,
    firstMessagePreview: "hello?",
    criteria: {
      status: "pending",
      generation: 1,
      criterionIds: ["crit-quick", "crit-search"],
    },
  },
];

const queryCalls: Array<{ name: string; args: unknown }> = [];
const paginatedCalls: Array<{ name: string; args: unknown }> = [];

let overviewData: SwarmOverview | undefined = overview;
let personasData: unknown = [persona];
let overviewThrows = false;
let waveSignalsData: SwarmWaveSignals | undefined;

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    queryCalls.push({ name, args });
    switch (name) {
      case "personas:listPersonas":
        return personasData;
      case "hosts:listHosts":
        return [{ hostId: "host-1", name: "Host One" }];
      case "journeyRuns:getSwarmOverview":
        if (overviewThrows) {
          throw new Error("Could not find public function getSwarmOverview");
        }
        return overviewData;
      case "swarmWaveInsights:getWaveSignals":
        return waveSignalsData;
      default:
        return undefined;
    }
  },
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  usePaginatedQuery: (name: string, args: unknown) => {
    paginatedCalls.push({ name, args });
    if (name === "journeyRuns:listSessionsByJourneyRun") {
      return {
        results: runSessions,
        status: "Exhausted",
        loadMore: vi.fn(),
        isLoading: false,
      };
    }
    return {
      results: [],
      status: "Exhausted",
      loadMore: vi.fn(),
      isLoading: false,
    };
  },
}));

const launchJourneyRunMock = vi.fn();
vi.mock("@/lib/swarm-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarm-api")>();
  return {
    ...actual,
    launchJourneyRun: (...args: unknown[]) => launchJourneyRunMock(...args),
  };
});

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: ({ threadId }: { threadId: string }) => (
    <div data-testid="viewer" data-thread-id={threadId} />
  ),
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
  useDbUserReady: () => true,
  useProjectServers: () => ({ servers: [], isLoading: false }),
}));
vi.mock("@/lib/scenario-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SwarmsTab } from "../SwarmsTab";
import { activeViewLabel } from "./swarms-tab-test-helpers";

function withGroup(
  run: SwarmOverviewRun,
  swarmRunGroupId?: string
): SwarmOverviewRun {
  return swarmRunGroupId ? { ...run, swarmRunGroupId } : { ...run };
}

function renderTab(swarmId?: string) {
  return render(
    <SwarmsTab
      projectId="proj-1"
      isAuthenticated
      swarmId={swarmId ?? null}
    />
  );
}

function waveRow(waveId: string): HTMLElement {
  const row = document.querySelector(`[data-wave-id="${waveId}"]`);
  if (!row) throw new Error(`no wave row for ${waveId}`);
  return row as HTMLElement;
}

beforeEach(() => {
  queryCalls.length = 0;
  paginatedCalls.length = 0;
  overviewData = overview;
  personasData = [persona];
  overviewThrows = false;
  waveSignalsData = undefined;
  launchJourneyRunMock.mockReset();
  window.history.replaceState({}, "", "/swarms");
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Overview — wire contract", () => {
  it("lands on Overview and subscribes getSwarmOverview with { projectId }", async () => {
    renderTab();
    expect(await screen.findByTestId("swarms-overview-panel")).toBeTruthy();
    expect(activeViewLabel()).toBe("Overview");

    const call = queryCalls.find(
      (c) => c.name === "journeyRuns:getSwarmOverview"
    );
    expect(call).toBeTruthy();
    expect(call!.args).toEqual({ projectId: "proj-1" });
  });

  it("list header has no project-wide Insights tab", async () => {
    renderTab();
    await screen.findByTestId("swarms-tab-header-chrome");
    const nav = screen.getByRole("navigation", { name: "Swarm view" });
    expect(within(nav).queryByRole("button", { name: "Insights" })).toBeNull();
    expect(within(nav).getByRole("button", { name: "Overview" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Personas" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Sessions" })).toBeTruthy();
  });
});

describe("waveLiveProgress", () => {
  it("counts every terminal attempt while at least one run is live", () => {
    const [newest, second] = overview.runs;
    expect(
      waveLiveProgress([
        {
          ...newest!,
          status: "running",
          summary: { total: 5, succeeded: 1, failed: 0, rateLimited: 0 },
        },
        {
          ...second!,
          status: "completed",
          summary: { total: 5, succeeded: 2, failed: 1, rateLimited: 1 },
        },
      ])
    ).toEqual({ done: 5, total: 10, liveRuns: 1 });
  });

  it("returns null when every run is terminal, and 0-total live runs stay live", () => {
    const [newest] = overview.runs;
    expect(waveLiveProgress([newest!])).toBeNull();
    // A run that has not published its fan-out yet is starting, not finished.
    expect(
      waveLiveProgress([
        {
          ...newest!,
          status: "pending",
          summary: { total: 0, succeeded: 0, failed: 0, rateLimited: 0 },
        },
      ])
    ).toEqual({ done: 0, total: 0, liveRuns: 1 });
  });
});

describe("groupRunsIntoSwarmWaves", () => {
  // Legacy rows carry no wave id, so the time heuristic still has to work.
  it("clusters co-launched journey-runs and keeps distant ones separate", () => {
    const waves = groupRunsIntoSwarmWaves(overview.runs);
    expect(waves).toHaveLength(3);
    expect(waves[0]!.waveId).toBe("run-2b");
    expect(waves[0]!.runs.map((r) => r.runId)).toEqual(["run-2b", "run-2"]);
    expect(waves[1]!.runs.map((r) => r.runId)).toEqual(["run-1"]);
    expect(waves[2]!.runs.map((r) => r.runId)).toEqual(["run-old"]);
  });

  it("groups by wave id even when a legacy run sits between siblings", () => {
    // The whole reason grouping can't stay a single-lookback walk: bucket
    // members need not be adjacent once an ungrouped row interleaves.
    const [newest, second, third, oldest] = overview.runs;
    const waves = groupRunsIntoSwarmWaves([
      withGroup(newest!, "wave-a"),
      withGroup(second!), // legacy, between two members of wave-a
      withGroup(third!, "wave-a"),
      withGroup(oldest!),
    ]);

    const waveA = waves.find((w) => w.runs.length === 2);
    expect(waveA!.runs.map((r) => r.runId)).toEqual([
      newest!.runId,
      third!.runId,
    ]);
    // Anchor is the NEWEST member, which downstream reads as the wave's time.
    expect(waveA!.waveId).toBe(newest!.runId);
    expect(waveA!.createdAt).toBe(newest!.createdAt);
  });

  it("keeps two waves separate even when launched in the same instant", () => {
    // The exact case the time heuristic cannot express: two people launching
    // at once used to merge into one row.
    const [newest, second] = overview.runs;
    const waves = groupRunsIntoSwarmWaves([
      withGroup(newest!, "wave-a"),
      withGroup({ ...second!, createdAt: newest!.createdAt }, "wave-b"),
    ]);
    expect(waves).toHaveLength(2);
    expect(waves.map((w) => w.runs.length)).toEqual([1, 1]);
  });

  it("returns waves newest-first when grouped and legacy rows interleave", () => {
    // Bucket insertion order is first-encounter, not recency — and the score
    // delta treats a higher index as strictly older.
    const [newest, second, third, oldest] = overview.runs;
    const waves = groupRunsIntoSwarmWaves([
      withGroup(newest!), // legacy, newest overall
      withGroup(second!, "wave-a"),
      withGroup(third!, "wave-a"),
      withGroup(oldest!, "wave-b"),
    ]);
    const times = waves.map((w) => w.createdAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(waves[0]!.runs.map((r) => r.runId)).toEqual([newest!.runId]);
  });

  it("does not let a grouped run anchor a legacy run's time window", () => {
    // An explicit wave must not absorb an unrelated solo run that merely
    // launched nearby.
    const [newest, second] = overview.runs;
    const waves = groupRunsIntoSwarmWaves([
      withGroup(newest!, "wave-a"),
      withGroup(second!), // 5s later, but ungrouped ⇒ its own wave
    ]);
    expect(waves).toHaveLength(2);
  });
});

describe("Overview — swarm runs (waves), not bare journeys", () => {
  it("lists co-launched journeys as ONE Swarm Run titled by short id", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    expect(screen.queryByText("Runs · by client")).toBeNull();
    expect(screen.getByTestId("swarm-overview-env-filter")).toBeTruthy();
    expect(screen.getByTestId("swarm-overview-client-filter")).toBeTruthy();
    expect(screen.getByText("Model")).toBeTruthy();

    const rows = screen.getAllByTestId("swarm-overview-run");
    expect(rows).toHaveLength(3);

    // Newest wave: two personas, ID-first title (evals-style), scope in subtitle.
    expect(rows[0]!.getAttribute("data-wave-id")).toBe("run-2b");
    expect(rows[0]!.getAttribute("data-journey-count")).toBe("2");
    expect(within(rows[0]!).getByText("Swarm run-2b")).toBeTruthy();
    expect(within(rows[0]!).getByText(/2 goals · 2 personas/)).toBeTruthy();
    // Env is its own flag-gated column; Client is host names only.
    expect(
      within(rows[0]!).getByTestId("swarm-overview-run-env").textContent
    ).toBe("Prod · Claude");
    // Client column is a logo strip; title keeps the host-name summary.
    expect(
      within(rows[0]!).getByTestId("swarm-overview-run-client")
    ).toHaveAttribute("title", "Claude +1");
    expect(
      within(rows[0]!).getByTestId("swarm-overview-run-model").textContent
    ).toBe("claude-haiku-4.5 +1");

    // Solo older waves also use short route ids, not journey · persona titles.
    expect(within(rows[1]!).getByText("Swarm run-1")).toBeTruthy();
    expect(
      within(rows[1]!).getByTestId("swarm-overview-run-env").textContent
    ).toBe("—");
    expect(
      within(rows[1]!).getByTestId("swarm-overview-run-client")
    ).toHaveAttribute("title", "Claude");
    expect(
      within(rows[1]!).getByTestId("swarm-overview-run-model").textContent
    ).toBe("claude-haiku-4.5");
    expect(within(rows[2]!).getByText("Swarm run-old")).toBeTruthy();
    expect(
      within(rows[2]!).getByTestId("swarm-overview-run-client")
    ).toHaveAttribute("title", "—");
  });

  it("does not render a score column on the list", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");
    expect(screen.queryByTestId("swarm-overview-run-score")).toBeNull();
    expect(screen.queryByTestId("swarm-overview-sort")).toBeNull();
    expect(document.querySelector(".lucide-chevron-right")).toBeNull();
  });

  it("renders the filter toolbar", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-filters");
    expect(screen.getByTestId("swarm-overview-client-filter")).toBeTruthy();
    expect(screen.getByTestId("swarm-overview-env-filter")).toBeTruthy();
  });

  /**
   * Asserted on classes rather than pixels because the regression is invisible
   * to jsdom layout: the filtering headers kept `SelectTrigger`'s
   * `dark:bg-input/30` (tailwind-merge won't drop it for an unprefixed
   * `bg-transparent`), so in dark mode Client sat in a form-field box while
   * the inert Model label stayed flat.
   */
  it("gives every column header the same ghost treatment, dark mode included", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-filters");

    const headers = [
      screen.getByTestId("swarm-overview-env-filter"),
      screen.getByTestId("swarm-overview-client-filter"),
      screen.getByTestId("swarm-overview-model-label"),
    ];

    for (const header of headers) {
      for (const className of SWARM_COLUMN_HEADER.split(" ")) {
        expect(header.classList.contains(className)).toBe(true);
      }
      expect(
        [...header.classList].filter((className) =>
          /(^|:)bg-(?!transparent)/.test(className)
        )
      ).toEqual([]);
    }
  });

  it("filterAndSortSwarmWaves filters by client / env and sorts by lowest score", () => {
    const waves = groupRunsIntoSwarmWaves(overview.runs);
    expect(waves.map((w) => w.waveId)).toEqual(["run-2b", "run-1", "run-old"]);

    const byCursor = filterAndSortSwarmWaves(waves, {
      clientFilter: "Cursor",
      envFilter: null,
      sort: "newest",
    });
    expect(byCursor.map((w) => w.waveId)).toEqual(["run-2b"]);

    const byEnv = filterAndSortSwarmWaves(waves, {
      clientFilter: null,
      envFilter: "Prod · Claude",
      sort: "newest",
    });
    expect(byEnv.map((w) => w.waveId)).toEqual(["run-2b"]);

    const byScore = filterAndSortSwarmWaves(waves, {
      clientFilter: null,
      envFilter: null,
      sort: "lowest-score",
    });
    // 40% then 70%; ungraded run-old last.
    expect(byScore.map((w) => w.waveId)).toEqual([
      "run-1",
      "run-2b",
      "run-old",
    ]);
  });
});

describe("Overview — navigate to Swarm Run detail", () => {
  it("navigates to /swarms/{waveId} when a legacy row has no swarmRunGroupId", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    fireEvent.click(
      within(waveRow("run-2b")).getByTestId("swarm-overview-run-open")
    );
    expect(window.location.pathname).toBe("/swarms/run-2b");
  });

  it("navigates to /swarms/{swarmRunGroupId} when the wave carries one", async () => {
    const [newest, second, ...rest] = overview.runs;
    overviewData = {
      ...overview,
      runs: [
        withGroup(newest!, "wave-nightly"),
        withGroup(second!, "wave-nightly"),
        ...rest,
      ],
    };
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    const row = document.querySelector(
      '[data-swarm-id="wave-nightly"]'
    ) as HTMLElement;
    expect(row).toBeTruthy();
    fireEvent.click(within(row).getByTestId("swarm-overview-run-open"));
    expect(window.location.pathname).toBe("/swarms/wave-nightly");
  });

  it("does not expand findings inline on the list", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");
    expect(screen.queryByTestId("swarm-overview-wave-findings")).toBeNull();
    expect(screen.queryByTestId("swarm-overview-finding")).toBeNull();
  });
});

describe("Swarm Run detail — /swarms/:swarmId", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders title and detail tabs for a known wave", async () => {
    renderTab("run-2b");
    expect(await screen.findByTestId("swarm-run-detail")).toBeTruthy();
    expect(screen.getByTestId("swarm-run-detail-title").textContent).toBe(
      "Swarm run-2b"
    );
    expect(await screen.findByTestId("swarm-findings-tab")).toBeTruthy();
    expect(screen.queryByTestId("swarm-insights-statline")).toBeNull();
    expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Personas" })).toBeNull();
    expect(screen.getByRole("button", { name: "Findings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Insights" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeTruthy();
    expect(screen.queryByTestId("swarm-run-detail-score")).toBeNull();
    expect(screen.queryByTestId("swarms-tab-header-chrome")).toBeNull();
  });

  it("does not render the retired launch-outcome strip", async () => {
    // The wave needs a durable group id, or the detail page dispatches
    // `getWaveSignals` with "skip" and this fixture never reaches the
    // component — the assertions below would pass with the strip re-added.
    const [newest, second, ...rest] = overview.runs;
    overviewData = {
      ...overview,
      runs: [
        withGroup(newest!, "wave-nightly"),
        withGroup(second!, "wave-nightly"),
        ...rest,
      ],
    };
    waveSignalsData = {
      candidates: [],
      targetHealth: [
        {
          subjectKind: "environment",
          subjectId: "env-1",
          subjectLabel: "Prod stack",
          attempted: 4,
          succeeded: 1,
          failed: 2,
          rateLimited: 1,
        },
      ],
      sessionCount: 0,
      unanalyzedSessionCount: 0,
      judgeCoverage: { graded: 0, total: 0 },
      truncated: false,
      lowConfidence: false,
      terminal: true,
    };

    renderTab("wave-nightly");

    expect(await screen.findByTestId("swarm-run-detail")).toBeTruthy();
    // The query really fired with this wave's args, so the target-health
    // fixture above did reach the component.
    const signalsCall = queryCalls.find(
      (c) => c.name === "swarmWaveInsights:getWaveSignals"
    );
    expect(signalsCall).toBeTruthy();
    expect(signalsCall!.args).toMatchObject({ swarmRunGroupId: "wave-nightly" });
    expect(screen.queryByTestId("swarm-target-health")).toBeNull();
    expect(screen.queryByText(/Some launches did not reach a session/i)).toBeNull();
  });

  it("shows wave-scoped Sankey on the Insights tab", async () => {
    renderTab("run-2b");
    await screen.findByTestId("swarm-run-detail");

    fireEvent.click(screen.getByRole("button", { name: "Insights" }));
    expect(await screen.findByTestId("swarm-insights-panel")).toBeTruthy();
    const sankeyCall = queryCalls.find(
      (c) => c.name === "chatSessions:getSwarmUsageBreakdown"
    );
    expect(sankeyCall).toBeTruthy();
    expect(sankeyCall!.args).toMatchObject({
      projectId: "proj-1",
      journeyRunIds: expect.arrayContaining(["run-2b", "run-2"]),
    });
    expect(screen.queryByTestId("swarm-insights-scorecard")).toBeNull();
    expect(screen.queryByTestId("swarm-insights-findings")).toBeNull();
    expect(screen.queryByTestId("swarm-overview-wave-findings")).toBeNull();
    expect(screen.queryByTestId("swarm-overview-finding")).toBeNull();
  });

  it("copies the share URL", async () => {
    renderTab("run-2b");
    await screen.findByTestId("swarm-run-detail");

    fireEvent.click(screen.getByTestId("swarm-run-detail-share"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://app.test/swarms/run-2b"
    );
  });

  it("shows a missing state for an unknown swarm id", async () => {
    renderTab("does-not-exist");
    expect(await screen.findByTestId("swarm-run-detail-missing")).toBeTruthy();
    expect(screen.getByText(/Swarm run not found/)).toBeTruthy();
  });

  /**
   * A finding followed out of the create wizard lands here, and the wizard's
   * Running step has no URL to go back to — so this page is the ONLY thing that
   * can say the run is still going and offer the way back to it. Asserted on the
   * deep-linked shape (`?tab=sessions&session=`) because that is what the
   * "Look now" link mints.
   */
  it("shows live progress and a way back to the run while the wave is running", async () => {
    const [newest, second, ...rest] = overview.runs;
    overviewData = {
      ...overview,
      runs: [
        {
          ...newest!,
          status: "running",
          summary: { total: 5, succeeded: 1, failed: 0, rateLimited: 0 },
        },
        {
          ...second!,
          status: "running",
          summary: { total: 15, succeeded: 3, failed: 1, rateLimited: 0 },
        },
        ...rest,
      ],
    };
    window.history.replaceState(
      {},
      "",
      "/swarms/run-2b?tab=sessions&session=thread-fail"
    );
    renderTab("run-2b");

    const live = await screen.findByTestId("swarm-run-detail-live");
    expect(live.textContent).toMatch(/still running/i);
    // Terminal attempts, not just successes: 1 + 3 + 1 of 20.
    expect(live.textContent).toMatch(/5 of 20 sessions/);
    expect(
      screen
        .getByTestId("swarm-run-detail-live-progress")
        .getAttribute("aria-valuenow")
    ).toBe("25");

    fireEvent.click(screen.getByTestId("swarm-run-detail-back-to-run"));
    // Same tab, minus the focused session: back to the whole run.
    expect(window.location.pathname).toBe("/swarms/run-2b");
    expect(window.location.search).toBe("?tab=sessions");
  });

  it("shows no live strip once every run in the wave is terminal", async () => {
    renderTab("run-2b");
    await screen.findByTestId("swarm-run-detail");
    expect(screen.queryByTestId("swarm-run-detail-live")).toBeNull();
  });

  it("does not show rubric findings on the Insights tab", async () => {
    renderTab("run-2b");
    await screen.findByTestId("swarm-run-detail");
    fireEvent.click(screen.getByRole("button", { name: "Insights" }));
    expect(screen.queryByTestId("swarm-overview-wave-findings")).toBeNull();
    expect(screen.queryByTestId("swarm-overview-finding")).toBeNull();
  });
});

describe("Overview — goal completion trend", () => {
  it("renders the daily trend strip when the window has graded days", async () => {
    overviewData = {
      ...overviewData!,
      goalCompletion: {
        gradedCount: 20,
        passedCount: 11,
        passRate: 11 / 20,
        runsWithGrades: 3,
        trend: [
          { dayStartMs: NOW - 2 * 86_400_000, gradedCount: 8, passedCount: 4, passRate: 0.5 },
          { dayStartMs: NOW - 86_400_000, gradedCount: 12, passedCount: 7, passRate: 7 / 12 },
        ],
      },
    };
    renderTab();
    const strip = await screen.findByTestId("swarm-overview-goal-trend");
    // Window pass rate headline (11/20 = 55%), with its denominators.
    expect(within(strip).getByText("55%")).toBeTruthy();
    expect(strip.textContent).toContain("11/20 graded sessions");
    expect(
      within(strip).getByTestId("swarm-overview-goal-trend-sparkline"),
    ).toBeTruthy();
  });

  it("renders NO strip for a single graded day — one day is a number, not a trend", async () => {
    overviewData = {
      ...overviewData!,
      goalCompletion: {
        gradedCount: 8,
        passedCount: 4,
        passRate: 0.5,
        runsWithGrades: 1,
        trend: [
          { dayStartMs: NOW - 86_400_000, gradedCount: 8, passedCount: 4, passRate: 0.5 },
        ],
      },
    };
    renderTab();
    await screen.findByTestId("swarm-overview-runs");
    expect(screen.queryByTestId("swarm-overview-goal-trend")).toBeNull();
  });

  it("renders NO strip when the window pass rate is null — nothing honest to headline", async () => {
    // Can't happen from today's server (trend buckets imply grades), but the
    // strip reads wire data and must not render "—%" over a sparkline.
    overviewData = {
      ...overviewData!,
      goalCompletion: {
        gradedCount: 0,
        passedCount: 0,
        passRate: null,
        runsWithGrades: 0,
        trend: [
          { dayStartMs: NOW - 2 * 86_400_000, gradedCount: 1, passedCount: 1, passRate: 1 },
          { dayStartMs: NOW - 86_400_000, gradedCount: 1, passedCount: 0, passRate: 0 },
        ],
      },
    };
    renderTab();
    await screen.findByTestId("swarm-overview-runs");
    expect(screen.queryByTestId("swarm-overview-goal-trend")).toBeNull();
  });
});

describe("Overview — empty and loading states", () => {
  it("renders the create-persona hero when the project has no personas", async () => {
    personasData = [];
    renderTab();
    expect(await screen.findByTestId("swarms-empty-hero")).toBeTruthy();
  });

  it("renders a distinct no-runs state when personas exist but nothing ran", async () => {
    overviewData = {
      runs: [],
      runsConsidered: 0,
      goalCompletion: {
        gradedCount: 0,
        passedCount: 0,
        passRate: null,
        runsWithGrades: 0,
        trend: [],
      },
    };
    renderTab();
    expect(await screen.findByTestId("swarm-overview-no-runs")).toBeTruthy();
    expect(screen.queryByTestId("swarms-empty-hero")).toBeNull();
    expect(screen.queryByTestId("swarm-overview-metric-cards")).toBeNull();
  });

  it("shows the loading shell — NOT the hero — while the persona list is loading", async () => {
    personasData = undefined;
    renderTab();
    expect(await screen.findByTestId("swarm-overview-loading")).toBeTruthy();
    expect(screen.queryByTestId("swarms-empty-hero")).toBeNull();
  });

  it("falls back to the empty state — not a blank tab — when the query THROWS", async () => {
    overviewThrows = true;
    renderTab();
    expect(await screen.findByTestId("swarm-overview-no-runs")).toBeTruthy();
  });

  it("renders a loading shell — not a crash — while the query is undefined", async () => {
    overviewData = undefined;
    renderTab();
    expect(await screen.findByTestId("swarm-overview-loading")).toBeTruthy();
    expect(screen.getByTestId("swarms-overview-panel")).toBeTruthy();
  });
});

describe("Swarm header chrome", () => {
  const SUBTITLE =
    "No recruiting, no scheduling, no setup. Agents find what breaks in every client.";

  it("keeps tabs inline and drops the subtitle on the empty state", async () => {
    personasData = [];
    renderTab();
    await screen.findByTestId("swarms-empty-hero");
    const header = screen.getByTestId("swarms-tab-header-chrome");
    const title = within(header).getByRole("heading", { name: "Swarm" });
    const row = title.closest("div.flex.items-center.justify-between");
    expect(row?.contains(within(header).getByRole("button", { name: "Overview" }))).toBe(
      true,
    );
    expect(screen.queryByText(SUBTITLE)).toBeNull();
  });

  it("keeps that chrome once the project has personas and runs", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");
    expect(screen.queryByTestId("swarms-empty-hero")).toBeNull();
    expect(screen.queryByText(SUBTITLE)).toBeNull();
    expect(
      screen.queryByText("The library of user personas you send into swarms."),
    ).toBeNull();
  });
});
