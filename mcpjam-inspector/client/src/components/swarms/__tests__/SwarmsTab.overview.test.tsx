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

const persona = {
  _id: "persona-1",
  personaId: "p1",
  name: "Persona One",
  role: "tester",
  notes: "",
};

const overview: SwarmOverview = {
  runs: [
    {
      runId: "run-2",
      journeyRefId: "journey-1",
      journeyName: "Refund flow",
      journeyArchived: false,
      personaName: "Persona One",
      createdAt: Date.now() - 60_000,
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
      createdAt: Date.now() - 7_200_000,
      status: "partial",
      summary: { total: 15, succeeded: 12, failed: 3, rateLimited: 0 },
      findings: [],
    },
    {
      runId: "run-old",
      journeyRefId: "journey-archived",
      journeyName: "Retired flow",
      journeyArchived: true,
      personaName: "Persona One",
      createdAt: Date.now() - 90_000_000,
      status: "completed",
      summary: { total: 2, succeeded: 2, failed: 0, rateLimited: 0 },
      findings: [],
    },
  ],
  runsConsidered: 3,
  goalCompletion: {
    gradedCount: 6,
    passedCount: 3,
    passRate: 0.5,
    runsWithGrades: 1,
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
      // A day with no latency sample at all — the series coalesces it rather
      // than dropping the point, which keeps it aligned with its date label.
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
    // Still grading: `results` is absent, so it must not be offered as an
    // affected session even though it belongs to the run.
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

/** Flipped per-test to exercise the pre-deploy `undefined` shell. */
let overviewData: SwarmOverview | undefined = overview;
let personasData: unknown = [persona];
/** Flipped per-test to exercise the pre-deploy THROWING shell (undeployed query). */
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

describe("Overview — runs grouped by journey", () => {
  it("groups runs under one journey header with the persona name", async () => {
    renderTab();
    await screen.findByTestId("swarms-overview-panel");

    const cards = screen.getAllByTestId("swarm-overview-journey");
    expect(cards).toHaveLength(2); // journey-1 (2 runs) + journey-archived

    const refundCard = journeyCard("journey-1");
    expect(within(refundCard).getByText("Refund flow")).toBeTruthy();
    expect(within(refundCard).getByText(/Persona One/)).toBeTruthy();
    expect(
      within(refundCard).getAllByTestId("swarm-overview-run")
    ).toHaveLength(2);
  });

  it("scores each run from its judge rollup, and renders '—' when nothing was graded", async () => {
    renderTab();
    await screen.findByTestId("swarms-overview-panel");

    const rows = within(journeyCard("journey-1")).getAllByTestId(
      "swarm-overview-run"
    );
    // run-2: 3 of 6 passed.
    expect(within(rows[0]).getByText("50%")).toBeTruthy();
    // run-1 has no goalScoreSummary at all — the judge never ran. A 0% here
    // would read as "every session failed" instead of "nothing was graded".
    expect(within(rows[1]).getByText("—")).toBeTruthy();
  });

  it("shows the goal-completion card with a sample-honest sub", async () => {
    renderTab();
    const cards = await screen.findByTestId("swarm-overview-metric-cards");
    expect(within(cards).getByText("50%")).toBeTruthy();
    expect(
      within(cards).getByText("6 graded sessions across 1 run")
    ).toBeTruthy();
  });
});

describe("Overview — findings", () => {
  it("renders findings for the LATEST run only, with the graded denominator and streak", async () => {
    renderTab();
    await screen.findByTestId("swarms-overview-panel");

    const findings = within(journeyCard("journey-1")).getAllByTestId(
      "swarm-overview-finding"
    );
    expect(findings).toHaveLength(2);

    // 6 (graded), NOT 15 (the run's session total) — nine verdicts are still
    // in flight and have nothing to say about this criterion.
    expect(
      within(findings[0]).getByText(/4 of 6 sessions · 2 runs/)
    ).toBeTruthy();
    expect(within(findings[0]).getByText("Quick resolution")).toBeTruthy();
    expect(within(findings[0]).getByText(/9 still grading/)).toBeTruthy();
    // 4 of 6 ≥ half ⇒ blocking; 1 of 6 ⇒ degraded.
    expect(within(findings[0]).getByText("blocking")).toBeTruthy();
    expect(within(findings[1]).getByText("degraded")).toBeTruthy();
    // A single-run streak renders the bare count — no "· N runs" suffix at all,
    // in either the plural or the singular.
    expect(within(findings[1]).getByText("1 of 6 sessions")).toBeTruthy();
  });

  it("falls back to the predicate-kind label when the criterion is unlabelled", async () => {
    renderTab();
    await screen.findByTestId("swarms-overview-panel");
    const findings = within(journeyCard("journey-1")).getAllByTestId(
      "swarm-overview-finding"
    );
    expect(
      within(findings[1]).getByText("Tool was called at least once")
    ).toBeTruthy();
  });

  it("states the honest Run again semantics", async () => {
    renderTab();
    await screen.findByTestId("swarms-overview-panel");
    expect(
      screen.getByText(
        "Run again launches this journey with its current configuration."
      )
    ).toBeTruthy();
  });

  it("renders no findings block for a journey whose latest run has none", async () => {
    renderTab();
    await screen.findByTestId("swarms-overview-panel");
    expect(
      within(journeyCard("journey-archived")).queryByTestId(
        "swarm-overview-findings"
      )
    ).toBeNull();
  });
});

describe("Overview — finding drill-down", () => {
  it("expands to the sessions that FAILED the criterion, paginating the run", async () => {
    renderTab();
    await screen.findByTestId("swarms-overview-panel");

    const finding = within(journeyCard("journey-1")).getAllByTestId(
      "swarm-overview-finding"
    )[0];
    fireEvent.click(finding);

    // CONTRACT: the existing run-sessions query, keyed `journeyRunId`.
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
    // Only the failing one: the passing session and the still-grading session
    // (no `results` at all) are both excluded.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].getAttribute("data-session-id")).toBe("thread-fail");
    expect(within(sessions[0]).getByText(/I want my money back/)).toBeTruthy();
  });

  it("opens the clicked session in the Sessions browser", async () => {
    renderTab();
    await screen.findByTestId("swarms-overview-panel");

    fireEvent.click(
      within(journeyCard("journey-1")).getAllByTestId(
        "swarm-overview-finding"
      )[0]
    );
    fireEvent.click(
      (await screen.findAllByTestId("swarm-overview-finding-session"))[0]
    );

    await waitFor(() => expect(activeViewLabel()).toBe("Sessions"));
    expect(screen.getByTestId("swarms-sessions-panel")).toBeTruthy();
    // Not just the shell: the viewer must open on the session that was clicked.
    // Asserting only the tab flip would still pass if the id were dropped on
    // the way through — including by the deep-link page walk.
    const viewer = await screen.findByTestId("viewer");
    expect(viewer.getAttribute("data-thread-id")).toBe("thread-fail");
  });
});

describe("Overview — Run again", () => {
  it("dispatches through the shared launch coordinator with an idempotency key", async () => {
    launchJourneyRunMock.mockResolvedValue({ runId: "run-3" });
    renderTab();
    await screen.findByTestId("swarms-overview-panel");

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
    // The coordinator's whole point: a double-click must not spawn (and bill)
    // two runs. Hold the launch open so the second click lands mid-flight.
    let release: (v: unknown) => void = () => {};
    launchJourneyRunMock.mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    );
    renderTab();
    await screen.findByTestId("swarms-overview-panel");

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
    await screen.findByTestId("swarms-overview-panel");

    const button = within(journeyCard("journey-archived")).getByRole("button", {
      name: "Run again",
    });
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
    // The cards still render — with "—", not 0%.
    const cards = screen.getByTestId("swarm-overview-metric-cards");
    expect(within(cards).getByText("no sessions graded yet")).toBeTruthy();
  });

  it("shows the loading shell — NOT the hero — while the persona list is loading", async () => {
    // `undefined` personas is "we don't know yet", not "you have none".
    // Collapsing the two flashes create-your-first-persona at every existing
    // user on every mount.
    personasData = undefined;
    renderTab();
    expect(await screen.findByTestId("swarm-overview-loading")).toBeTruthy();
    expect(screen.queryByTestId("swarms-empty-hero")).toBeNull();
  });

  it("falls back to the empty state — not a blank tab — when the query THROWS", async () => {
    // `useQuery` throws for a function the backend hasn't deployed yet, which
    // is exactly the window between these two PRs. A `null` fallback would
    // leave the DEFAULT tab blank; the empty state at least says what to do.
    overviewThrows = true;
    renderTab();
    expect(await screen.findByTestId("swarm-overview-no-runs")).toBeTruthy();
  });

  it("renders a loading shell — not a crash — while the query is undefined", async () => {
    // This is the pre-backend-deploy shape, and the shape every other
    // SwarmsTab suite renders under. An ErrorBoundary does not catch
    // `undefined.runs`, so the shell has to be explicit.
    overviewData = undefined;
    renderTab();
    expect(await screen.findByTestId("swarm-overview-loading")).toBeTruthy();
    expect(screen.getByTestId("swarms-overview-panel")).toBeTruthy();
  });
});
