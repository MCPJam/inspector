import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  JourneySessionRow,
  SwarmOverview,
  SwarmSessionMetrics,
} from "@/lib/swarm-api";
import { groupRunsIntoSwarmWaves } from "../swarm-overview-panel";

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

/** Real day-start boundaries, so the sparkline's date labels are meaningful. */
const DAY_MS = 86_400_000;
const DAY_2 = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const DAY_1 = DAY_2 - DAY_MS;

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
    },
  ],
  runsConsidered: 4,
  goalCompletion: {
    gradedCount: 20,
    passedCount: 11,
    passRate: 11 / 20,
    runsWithGrades: 3,
    trend: [
      { dayStartMs: DAY_1, gradedCount: 2, passedCount: 1, passRate: 0.5 },
      { dayStartMs: DAY_2, gradedCount: 4, passedCount: 4, passRate: 1 },
    ],
  },
};

const metrics: SwarmSessionMetrics = {
  sessionCount: 30,
  analyzedCount: 30,
  truncated: false,
  toolCallCount: 120,
  toolErrorCount: 4,
  toolErrorRate: 0.033,
  sessionsWithToolErrors: 3,
  topFailingTool: { toolName: "search", errorCount: 3 },
  avgToolCallsPerSession: 4,
  latencyP50Ms: 1200,
  latencyP95Ms: 4800,
  avgTokensPerSession: 5400,
  tokenSampleCount: 30,
  trend: [
    {
      dayStartMs: DAY_1,
      sessionCount: 12,
      toolErrorRate: 0.02,
      avgToolCallsPerSession: 3,
      latencyP50Ms: null,
      latencyP95Ms: null,
      avgTokensPerSession: 4800,
    },
    {
      dayStartMs: DAY_2,
      sessionCount: 18,
      toolErrorRate: 0.04,
      avgToolCallsPerSession: 5,
      latencyP50Ms: 1200,
      latencyP95Ms: 4800,
      avgTokensPerSession: 5800,
    },
  ],
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
      case "journeyRuns:getSwarmSessionMetrics":
        return metrics;
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
vi.mock("@/lib/chatbox-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SwarmsTab } from "../SwarmsTab";
import { activeViewLabel } from "./swarms-tab-test-helpers";

function renderTab() {
  return render(<SwarmsTab projectId="proj-1" isAuthenticated />);
}

function waveRow(waveId: string): HTMLElement {
  const row = document.querySelector(`[data-wave-id="${waveId}"]`);
  if (!row) throw new Error(`no wave row for ${waveId}`);
  return row as HTMLElement;
}

function journeyCard(journeyRefId: string): HTMLElement {
  const card = document.querySelector(`[data-journey-id="${journeyRefId}"]`);
  if (!card) throw new Error(`no journey card for ${journeyRefId}`);
  return card as HTMLElement;
}

beforeEach(() => {
  queryCalls.length = 0;
  paginatedCalls.length = 0;
  overviewData = overview;
  personasData = [persona];
  overviewThrows = false;
  launchJourneyRunMock.mockReset();
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

  it("reads the metric cards from getSwarmSessionMetrics, project-scoped", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-metric-cards");
    const call = queryCalls.find(
      (c) => c.name === "journeyRuns:getSwarmSessionMetrics"
    );
    expect(call!.args).toEqual({ projectId: "proj-1" });
  });
});

describe("groupRunsIntoSwarmWaves", () => {
  it("clusters co-launched journey-runs and keeps distant ones separate", () => {
    const waves = groupRunsIntoSwarmWaves(overview.runs);
    expect(waves).toHaveLength(3);
    expect(waves[0]!.waveId).toBe("run-2b");
    expect(waves[0]!.runs.map((r) => r.runId)).toEqual(["run-2b", "run-2"]);
    expect(waves[1]!.runs.map((r) => r.runId)).toEqual(["run-1"]);
    expect(waves[2]!.runs.map((r) => r.runId)).toEqual(["run-old"]);
  });
});

describe("Overview — swarm runs (waves), not bare journeys", () => {
  it("lists co-launched journeys as ONE Swarm Run titled for scope", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    const rows = screen.getAllByTestId("swarm-overview-run");
    expect(rows).toHaveLength(3);

    // Newest wave: two personas ⇒ "Swarm · all personas", not a journey name.
    expect(rows[0]!.getAttribute("data-wave-id")).toBe("run-2b");
    expect(rows[0]!.getAttribute("data-journey-count")).toBe("2");
    expect(within(rows[0]!).getByText("Swarm · all personas")).toBeTruthy();
    expect(within(rows[0]!).getByText(/2 journeys · 2 personas/)).toBeTruthy();

    // Solo older waves keep the journey · persona title.
    expect(within(rows[1]!).getByText(/Refund flow · Persona One/)).toBeTruthy();
    expect(
      within(rows[2]!).getByText(/Retired flow · Persona One/)
    ).toBeTruthy();
  });

  it("scores a wave from the aggregate graded rollup across its journeys", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    // Latest wave: (4+3)/(4+6) = 70%.
    expect(
      within(waveRow("run-2b")).getByTestId("swarm-overview-run-score")
        .textContent
    ).toBe("70%");
    // run-1 wave: 4 of 10.
    expect(
      within(waveRow("run-1")).getByTestId("swarm-overview-run-score")
        .textContent
    ).toBe("40%");
    expect(
      within(waveRow("run-old")).getByTestId("swarm-overview-run-score")
        .textContent
    ).toBe("—");
  });

  it("shows SCORE change vs the previous graded wave", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    // 70% vs 40% ⇒ ▲ 30
    expect(
      within(waveRow("run-2b")).getByTestId("swarm-overview-run-change")
        .textContent
    ).toMatch(/▲\s*30/);
    expect(
      within(waveRow("run-1")).getByTestId("swarm-overview-run-change")
        .textContent
    ).toBe("—");
  });

  it("pins the goal-completion card to the LATEST wave", async () => {
    renderTab();
    const cards = await screen.findByTestId("swarm-overview-metric-cards");
    expect(within(cards).getByText("70%")).toBeTruthy();
    expect(
      within(cards).getByText("10 graded sessions · latest run")
    ).toBeTruthy();
  });
});

describe("Overview — per-journey view inside a wave", () => {
  it("auto-expands the newest wave that has findings and nests journeys there", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    expect(
      within(waveRow("run-2b")).getByTestId("swarm-overview-wave-journeys")
    ).toBeTruthy();
    expect(
      within(waveRow("run-2b")).getAllByTestId("swarm-overview-journey")
    ).toHaveLength(2);
    expect(within(journeyCard("journey-1")).getByText("Refund flow")).toBeTruthy();
    expect(
      within(journeyCard("journey-2")).getByText("Invoice lookup")
    ).toBeTruthy();

    // Older waves stay collapsed — journeys are not top-level.
    expect(
      within(waveRow("run-1")).queryByTestId("swarm-overview-wave-journeys")
    ).toBeNull();
    expect(screen.queryByText("Retired flow · Persona One")).toBeTruthy();
    expect(
      document.querySelector(
        '[data-wave-id="run-old"] [data-journey-id="journey-archived"]'
      )
    ).toBeNull();
  });

  it("toggles the nested journey panel when a Swarm Run row is clicked", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    fireEvent.click(
      within(waveRow("run-2b")).getByRole("button", { expanded: true })
    );
    expect(
      within(waveRow("run-2b")).queryByTestId("swarm-overview-wave-journeys")
    ).toBeNull();

    fireEvent.click(
      within(waveRow("run-1")).getByRole("button", { expanded: false })
    );
    expect(
      within(waveRow("run-1")).getByTestId("swarm-overview-wave-journeys")
    ).toBeTruthy();
    // Clean journeys stay header-only — no empty-findings copy.
    expect(
      within(journeyCard("journey-1")).queryByTestId("swarm-overview-findings")
    ).toBeNull();
  });

  it("renders findings on the nested journey with graded denominator and streak", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    const findings = within(journeyCard("journey-1")).getAllByTestId(
      "swarm-overview-finding"
    );
    expect(findings).toHaveLength(2);

    expect(within(findings[0]!).getByText(/4 of 6 sessions/)).toBeTruthy();
    expect(within(findings[0]!).getByText("Quick resolution")).toBeTruthy();
    expect(within(findings[0]!).getByText(/9 still grading/)).toBeTruthy();
    expect(within(findings[0]!).getByText("2 runs")).toBeTruthy();
    expect(within(findings[0]!).getByText("blocking")).toBeTruthy();
    expect(within(findings[1]!).getByText("degraded")).toBeTruthy();
    expect(within(findings[1]!).queryByText(/runs$/)).toBeNull();
    expect(within(findings[1]!).getByText("1 of 6 sessions")).toBeTruthy();
  });

  it("falls back to the predicate-kind label when the criterion is unlabelled", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");
    const findings = within(journeyCard("journey-1")).getAllByTestId(
      "swarm-overview-finding"
    );
    expect(
      within(findings[1]!).getByText("Tool was called at least once")
    ).toBeTruthy();
  });

  it("omits the findings block when a journey has none", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");
    // Invoice lookup (run-2b) is in the auto-expanded wave and has no findings.
    expect(
      within(journeyCard("journey-2")).queryByTestId("swarm-overview-findings")
    ).toBeNull();
    expect(
      within(journeyCard("journey-2")).getByRole("button", { name: "Run again" })
    ).toBeTruthy();
  });
});

describe("Overview — finding drill-down", () => {
  it("expands to the sessions that FAILED the criterion, paginating the run", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    const finding = within(journeyCard("journey-1")).getAllByTestId(
      "swarm-overview-finding"
    )[0]!;
    fireEvent.click(finding);

    await waitFor(() => {
      const call = paginatedCalls.find(
        (c) => c.name === "journeyRuns:listSessionsByJourneyRun"
      );
      expect(call).toBeTruthy();
      expect(call!.args).toEqual({ journeyRunId: "run-2" });
    });

    const sessions = await screen.findAllByTestId(
      "swarm-overview-finding-session"
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.getAttribute("data-session-id")).toBe("thread-fail");
    expect(within(sessions[0]!).getByText(/I want my money back/)).toBeTruthy();
  });

  it("opens the clicked session in the Sessions browser", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    fireEvent.click(
      within(journeyCard("journey-1")).getAllByTestId(
        "swarm-overview-finding"
      )[0]!
    );
    fireEvent.click(
      (await screen.findAllByTestId("swarm-overview-finding-session"))[0]!
    );

    await waitFor(() => expect(activeViewLabel()).toBe("Sessions"));
    expect(screen.getByTestId("swarms-sessions-panel")).toBeTruthy();
    const viewer = await screen.findByTestId("viewer");
    expect(viewer.getAttribute("data-thread-id")).toBe("thread-fail");
  });
});

describe("Overview — Run again", () => {
  it("dispatches through the shared launch coordinator with an idempotency key", async () => {
    launchJourneyRunMock.mockResolvedValue({ runId: "run-3" });
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    fireEvent.click(
      within(journeyCard("journey-1")).getByRole("button", {
        name: "Run again",
      })
    );

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    const arg = launchJourneyRunMock.mock.calls[0]![0] as any;
    expect(arg.journeyId).toBe("journey-1");
    expect(arg.projectId).toBe("proj-1");
    expect(typeof arg.launchKey).toBe("string");
    expect(arg.launchKey.length).toBeGreaterThan(0);
  });

  it("dedupes rapid clicks into ONE run while a launch is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    launchJourneyRunMock.mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    );
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    const button = within(journeyCard("journey-1")).getByRole("button", {
      name: "Run again",
    });
    fireEvent.click(button);
    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    fireEvent.click(button);

    release({ runId: "run-3" });
    await waitFor(() =>
      expect(
        within(journeyCard("journey-1")).getByRole("button", {
          name: "Run again",
        })
      ).not.toBeDisabled()
    );
    expect(launchJourneyRunMock).toHaveBeenCalledTimes(1);
  });

  it("is DISABLED for an archived journey — relaunching one throws server-side", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");

    fireEvent.click(
      within(waveRow("run-old")).getByRole("button", { expanded: false })
    );

    const button = within(journeyCard("journey-archived")).getByRole(
      "button",
      { name: "Run again" }
    );
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(launchJourneyRunMock).not.toHaveBeenCalled();
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
    const cards = screen.getByTestId("swarm-overview-metric-cards");
    expect(within(cards).getByText("no sessions graded yet")).toBeTruthy();
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
