import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageBreakdown } from "@/hooks/useUsageInsights";
import type {
  JourneySessionRow,
  SwarmOverview,
  SwarmOverviewRun,
  SwarmWaveSignals,
} from "@/lib/swarm-api";
import {
  groupRunsIntoSwarmWaves,
  swarmWaveRunStateChipClass,
  swarmWaveRunStateLabel,
  waveLiveProgress,
  waveRunState,
} from "../swarm-overview-panel";
import { describeSwarmIdentity } from "../swarm-run-header";

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
      serverNames: ["Asana"],
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
      serverNames: ["Linear"],
      swarmName: "Review refund flow",
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
const mutationCalls: Array<{ name: string; args: unknown }> = [];
/** Per-name mutation outcome; a test installs a rejection to exercise failure. */
let mutationResult: (name: string, args: unknown) => unknown = () => ({});

let overviewData: SwarmOverview | undefined = overview;
let personasData: unknown = [persona];
let overviewThrows = false;
let waveSignalsData: SwarmWaveSignals | undefined;
let usageBreakdown: UsageBreakdown | undefined;

vi.mock("convex/react", () => ({
  useConvex: () => ({
    query: async (_reference: unknown, { runIds }: { runIds: string[] }) =>
      runIds.map((runId) => ({
        journeyRefId: overviewData?.runs.find((run) => run.runId === runId)
          ?.journeyRefId,
        problems: [],
      })),
  }),
  useQuery: (query: string | FunctionReference<"query">, args: unknown) => {
    if (args === "skip") return undefined;
    const name = typeof query === "string" ? query : getFunctionName(query);
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
      case "chatSessions:getSwarmUsageBreakdown":
        return usageBreakdown;
      default:
        return undefined;
    }
  },
  // Recorded by NAME so a test can assert what a control actually wrote. The
  // Swarms reads are string-keyed and cast through `as any`, so a renamed
  // mutation would otherwise surface only as a button that silently does
  // nothing.
  useMutation: (name: string) => {
    const spy = vi.fn(async (args: unknown) => {
      mutationCalls.push({ name, args });
      return mutationResult(name, args);
    });
    return spy;
  },
  useAction: () => vi.fn(),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  usePaginatedQuery: (name: string, args: unknown) => {
    paginatedCalls.push({ name, args });
    if (
      name === "journeyRuns:listSessionsByJourneyRun" ||
      // The Sessions panel reads the PROJECT feed. Serving it here is what lets
      // a test see the focused-session viewer at all — without rows, the deep
      // link never applies and the panel renders an empty list.
      name === "journeyRuns:listSessionsByProject"
    ) {
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
const launchSwarmRunMock = vi.fn();
vi.mock("@/lib/swarm-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarm-api")>();
  return {
    ...actual,
    launchJourneyRun: (...args: unknown[]) => launchJourneyRunMock(...args),
    launchSwarmRun: (...args: unknown[]) => launchSwarmRunMock(...args),
    streamJourneyRun: vi.fn(async () => undefined),
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
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { SwarmsTab } from "../SwarmsTab";
import { toast } from "@/lib/toast";
import {
  LaunchJourneyRunError,
  LaunchSwarmRunError,
  type LaunchRecordView,
} from "@/lib/swarm-api";
import { activeViewLabel } from "./swarms-tab-test-helpers";

function withGroup(
  run: SwarmOverviewRun,
  swarmRunGroupId?: string
): SwarmOverviewRun {
  return swarmRunGroupId ? { ...run, swarmRunGroupId } : { ...run };
}

function renderTab(swarmId?: string) {
  return render(
    <SwarmsTab projectId="proj-1" isAuthenticated swarmId={swarmId ?? null} />,
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
  usageBreakdown = undefined;
  launchJourneyRunMock.mockReset();
  launchSwarmRunMock.mockReset();
  mutationCalls.length = 0;
  mutationResult = () => ({});
  window.history.replaceState({}, "", "/swarms");
});

afterEach(() => {
  vi.clearAllMocks();
});

/** A launch record as the server answers Run again with it. */
function launchRecord(
  state: LaunchRecordView["state"] = "launching",
  goals: LaunchRecordView["goals"] = [
    { goalId: "journey-2", launchKey: "k-2", status: "started", runId: "r-2" },
    { goalId: "journey-1", launchKey: "k-1", status: "pending" },
  ],
): LaunchRecordView {
  return {
    swarmRunId: "sr_next",
    swarmId: null,
    sourceSwarmRunId: "sr_wave",
    state,
    createdAt: NOW,
    goals,
  };
}

/** run-2 and run-2b as one swarm run, `sr_wave`, as runs launched since carry. */
function groupedOverview(): SwarmOverview {
  return {
    ...overview,
    runs: overview.runs.map((run) =>
      run.runId === "run-2" || run.runId === "run-2b"
        ? withGroup(run, "sr_wave")
        : run,
    ),
  };
}

/** Clicks Run again and waits for the button to come back from busy. */
async function runAgain() {
  fireEvent.click(await screen.findByTestId("swarm-run-detail-run-again"));
  await waitFor(() =>
    expect(
      screen.getByTestId("swarm-run-detail-run-again").hasAttribute("disabled"),
    ).toBe(false),
  );
}

const lastToast = (kind: "success" | "error") =>
  (toast[kind] as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(
    -1,
  );

const keyOfCall = (index: number) =>
  (launchSwarmRunMock.mock.calls[index]?.[0] as { idempotencyKey: string })
    .idempotencyKey;

describe("Run again — one launch on the server", () => {
  it("launches the whole swarm run with one call, and offers the new run", async () => {
    overviewData = groupedOverview();
    launchSwarmRunMock.mockResolvedValue({
      swarmRunId: "sr_next",
      launch: launchRecord(),
    });
    renderTab("sr_wave");
    await runAgain();

    expect(launchSwarmRunMock).toHaveBeenCalledTimes(1);
    expect(launchSwarmRunMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      swarmRun: "sr_wave",
      idempotencyKey: expect.any(String),
    });
    expect(launchJourneyRunMock).not.toHaveBeenCalled();
    const [message, options] = lastToast("success") ?? [];
    // "Started 15 goals" reported a count and stranded the viewer on the run
    // they had relaunched FROM.
    expect(message).toBe("New swarm run started — 2 goals");
    const action = (options as { action?: { label: string; onClick: () => void } })
      ?.action;
    expect(action?.label).toBe("View run");
    action?.onClick();
    expect(window.location.pathname).toBe("/swarms/sr_next");
  });

  it("sends the goals of a swarm run from before swarm run ids, which has none to name", async () => {
    launchSwarmRunMock.mockResolvedValue({
      swarmRunId: "sr_next",
      launch: launchRecord(),
    });
    renderTab("run-2b");
    await runAgain();

    expect(launchSwarmRunMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      goals: [{ goalId: "journey-2" }, { goalId: "journey-1" }],
      idempotencyKey: expect.any(String),
    });
  });

  it("keeps the key after a failure, so the retry replays the launch, and drops it once it lands", async () => {
    overviewData = groupedOverview();
    launchSwarmRunMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({ swarmRunId: "sr_next", launch: launchRecord() });
    renderTab("sr_wave");

    await runAgain();
    expect(lastToast("error")?.[0]).toBe("network down");
    await runAgain();
    await runAgain();

    expect(keyOfCall(1)).toBe(keyOfCall(0));
    expect(keyOfCall(2)).not.toBe(keyOfCall(1));
  });

  it("starts afresh after a launch that ended with nothing started", async () => {
    overviewData = groupedOverview();
    launchSwarmRunMock
      .mockRejectedValueOnce(
        new LaunchSwarmRunError(
          new LaunchJourneyRunError(400, "This journey has no pinned hosts to run"),
          launchRecord("failed"),
        ),
      )
      .mockResolvedValue({ swarmRunId: "sr_next", launch: launchRecord() });
    renderTab("sr_wave");

    await runAgain();
    expect(lastToast("error")?.[0]).toBe(
      "This journey has no pinned hosts to run",
    );
    await runAgain();
    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  it("leaves a limit refusal to its dialog, with no toast of its own", async () => {
    overviewData = groupedOverview();
    launchSwarmRunMock.mockRejectedValue(
      new LaunchJourneyRunError(429, "Daily MCPJam model limit reached.", true),
    );
    renderTab("sr_wave");
    await runAgain();

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("says why when the launch it replayed had started nothing", async () => {
    overviewData = groupedOverview();
    launchSwarmRunMock.mockResolvedValue({
      swarmRunId: "sr_next",
      launch: launchRecord("failed", [
        {
          goalId: "journey-2",
          launchKey: "k-2",
          status: "failed",
          error: { status: 404, message: "This goal was not found." },
        },
      ]),
    });
    renderTab("sr_wave");
    await runAgain();

    expect(lastToast("error")?.[0]).toBe("This goal was not found.");
    expect(toast.success).not.toHaveBeenCalled();
  });
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

describe("waveRunState", () => {
  // `running` still wins over every terminal status: a wave holding one goal
  // that settled badly and one still fanning out is running, and sending the
  // viewer away from a run that is still producing results is the bug.
  it("reports running while any goal is still going", () => {
    const [newest, second] = overview.runs;
    const runs = [
      { ...newest!, status: "failed" },
      { ...second!, status: "running" },
    ] as SwarmOverviewRun[];

    expect(waveRunState(runs)).toBe("running");
  });

  // "Failed" told the viewer nothing ran. It was never true: a `stale` run is
  // only one the sweeper gave up on, and `partial`/`rate_limited` runs produced
  // sessions too. All four now say the one honest thing — it did not finish
  // cleanly — under a single label.
  it.each(["failed", "stale", "partial", "rate_limited"])(
    "folds %s into the single not-clean outcome",
    (status) => {
      const [newest] = overview.runs;
      const runs = [{ ...newest!, status }] as SwarmOverviewRun[];

      expect(waveRunState(runs)).toBe("issues");
      expect(swarmWaveRunStateLabel(waveRunState(runs))).toBe(
        "Completed with issues"
      );
    }
  );

  it("retains an uncanceled failure beside a canceled goal", () => {
    const [first, second] = overview.runs;
    expect(
      waveRunState([
        { ...first!, status: "failed" },
        { ...second!, status: "failed", cancelRequested: true },
      ]),
    ).toBe("issues");
    expect(
      waveRunState([
        { ...first!, status: "completed" },
        { ...second!, status: "failed", cancelRequested: true },
      ]),
    ).toBe("stopped");
  });

  it("reports complete when every goal settled cleanly", () => {
    const [newest] = overview.runs;
    const runs = [{ ...newest!, status: "completed" }] as SwarmOverviewRun[];

    expect(waveRunState(runs)).toBe("complete");
  });

  // No caller may paint a not-clean wave red any more: one badge, one neutral
  // treatment, which is the whole point of collapsing the two buckets.
  it("gives the not-clean outcome a neutral chip, not a red one", () => {
    expect(swarmWaveRunStateChipClass("issues")).not.toMatch(/red/);
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

describe("describeSwarmIdentity", () => {
  it("titles a wave with the name its author gave the swarm", () => {
    const [newest, second] = overview.runs;
    const [wave] = groupRunsIntoSwarmWaves([
      withGroup({ ...newest!, swarmName: "Checkout regression" }, "wave-a"),
      withGroup({ ...second!, swarmName: "Checkout regression" }, "wave-a"),
    ]);
    expect(describeSwarmIdentity(wave!)).toMatchObject({
      heading: "Asana",
      title: "Checkout regression",
    });
  });

  it("falls back to Swarm and a date when server and name are missing", () => {
    // Runs launched outside a swarm, plus every row from a backend that
    // predates the field.
    const [newest] = overview.runs;
    const [wave] = groupRunsIntoSwarmWaves([
      withGroup({ ...newest!, serverNames: undefined }, "wave-a"),
    ]);
    expect(describeSwarmIdentity(wave!)).toMatchObject({
      heading: "Swarm",
      date: expect.any(String),
      title: undefined,
    });
  });

  it("names a mixed wave after its newest member's swarm", () => {
    // A reused journey carries its ORIGINAL swarm into another wave, so the
    // wave can hold two names — the newest run decides, as it does for the id.
    const [newest, second] = overview.runs;
    const [wave] = groupRunsIntoSwarmWaves([
      withGroup({ ...newest!, swarmName: "Checkout regression" }, "wave-a"),
      withGroup({ ...second!, swarmName: "Last quarter's swarm" }, "wave-a"),
    ]);
    expect(describeSwarmIdentity(wave!).title).toBe("Checkout regression");
  });

  it("keeps the server heading when only an older member is named", () => {
    // The case that separates "newest wins" from "first named wins": an ad-hoc
    // wave that reused ONE journey would otherwise be titled after the swarm
    // that journey was authored in.
    const [newest, second] = overview.runs;
    const [wave] = groupRunsIntoSwarmWaves([
      withGroup(newest!, "wave-a"),
      withGroup({ ...second!, swarmName: "Last quarter's swarm" }, "wave-a"),
    ]);
    expect(describeSwarmIdentity(wave!)).toMatchObject({
      heading: "Asana",
      title: undefined,
    });
  });

  it("treats an empty or whitespace-only name as no name at all", () => {
    // Legacy rows, and any writer that isn't the create flow — which trims.
    // Rendering these verbatim leaves the heading blank.
    const [newest] = overview.runs;
    for (const swarmName of ["", "   "]) {
      const [wave] = groupRunsIntoSwarmWaves([
        withGroup({ ...newest!, swarmName }, "wave-a"),
      ]);
      expect(describeSwarmIdentity(wave!).title).toBeUndefined();
    }
  });
});

describe("Overview — history and report", () => {
  it("uses content height and allows horizontal scrolling for column controls", async () => {
    usageBreakdown = {
      themes: [],
      userBreakdown: [],
      deviceBreakdown: [],
      languageBreakdown: [],
      modelBreakdown: [],
      outcomeBreakdown: [],
      frictionBreakdown: [],
      behaviorTagBreakdown: [],
      goalFacets: [],
      labeledOutcomeCount: 1,
      outcomeFeedbackCalibration: [],
      totalSessions: 1,
      sankey: {
        nodes: [
          {
            id: "goal:refund",
            stage: "goal",
            key: "refund",
            label: "Request a refund",
            count: 1,
            clickable: true,
          },
        ],
        links: [],
        foldedGoalCount: 0,
      },
    };
    renderTab();
    const report = within(await screen.findByTestId("swarm-overview-report"));
    expect(
      report.getByRole("group", { name: /Session flow from goal/ }),
    ).toBeInTheDocument();
    expect(report.getByTestId("scenario-insights-sankey")).not.toHaveAttribute(
      "data-fill-remaining",
    );
    expect(report.getByTestId("sankey-chart-pane")).toHaveClass(
      "overflow-x-auto",
    );
  });

  it("groups co-launched runs and leads with the saved server and date", async () => {
    const [first, ...otherRuns] = overview.runs;
    overviewData = { ...overview, runs: [{ ...first!, swarmName: "Swarm · Nov 18" }, ...otherRuns] };
    renderTab();
    const rows = await screen.findAllByTestId("swarm-overview-run-row");
    expect(rows).toHaveLength(3);
    const newest = within(rows[0]!);
    expect(newest.getByText("Asana")).toBeTruthy();
    expect(newest.getAllByText("Nov 18")).toHaveLength(1);
    expect(newest.getByText("20 sessions")).toBeTruthy();
    expect(newest.getByText("Persona One")).toBeTruthy();
    expect(newest.getByText("Persona Two")).toBeTruthy();
    expect(newest.getByTitle("Claude, Cursor")).toBeTruthy();
    expect(newest.queryByText(/Swarm run-2b|2 goals|Completed with issues/)).toBeNull();
    expect(within(rows[1]!).getByText("Review refund flow")).toBeTruthy();

    const report = within(screen.getByTestId("swarm-overview-report"));
    expect(report.getByRole("heading", { name: "Asana" })).toBeTruthy();
    expect(report.getByText("20/20 complete")).toBeTruthy();
    expect(report.getByRole("heading", { name: "Findings" })).toBeTruthy();
    expect(report.getByRole("heading", { name: "Session flow" })).toBeTruthy();
    expect(report.queryByText("Choose a persona")).toBeNull();
    expect(report.queryByText("Server account")).toBeNull();
  });

  it("narrows by search and restores history when filters are cleared", async () => {
    renderTab();
    const search = await screen.findByRole("searchbox", { name: "Search runs" });
    expect(screen.getByRole("combobox", { name: "All servers" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "All clients" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "linear" } });
    expect(screen.getAllByTestId("swarm-overview-run-row")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Linear" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "does not match" } });
    expect(screen.getByTestId("swarm-overview-filter-empty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByTestId("swarm-overview-run-row")).toHaveLength(3);
  });

  it("places a saved descriptive name beside the report's server and date", async () => {
    const [first, ...otherRuns] = overview.runs;
    overviewData = {
      ...overview,
      runs: [{ ...first!, swarmName: "Swarm · Checkout v2" }, ...otherRuns],
    };
    renderTab();
    const report = within(await screen.findByTestId("swarm-overview-report"));
    const date = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(first!.createdAt);
    const identity = report.getByRole("heading", { name: "Asana" }).parentElement;
    expect(identity).toHaveClass("flex-wrap");
    expect(report.getByText(date).parentElement).toBe(identity);
    expect(report.getByText("Swarm · Checkout v2").parentElement).toBe(identity);
  });

  it("selects a legacy run and opens its existing detail route", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");
    fireEvent.click(waveRow("run-1"));
    expect(window.location.pathname).toBe("/swarms");
    expect(screen.getByRole("heading", { name: "Linear" })).toBeTruthy();
    expect(screen.getByText("12/15 complete")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open full swarm" }));
    expect(window.location.pathname).toBe("/swarms/run-1");
  });

  it("selects a run from the history sheet and closes the sheet", async () => {
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Run history" }));
    const sheet = await screen.findByRole("dialog", { name: "Run history" });
    fireEvent.click(within(sheet).getByRole("button", { name: /Linear/ }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Run history" })).toBeNull();
    });
    expect(screen.getByRole("heading", { name: "Linear" })).toBeTruthy();
  });

  it("uses the wave id when opening a grouped run", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: "Open full swarm" }));
    expect(window.location.pathname).toBe("/swarms/wave-nightly");
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
    const heading = screen.getByTestId("swarm-run-detail-title");
    expect(heading.textContent).toBe("Asana");
    // The heading truncates, and authored names run to SWARM_NAME_MAX — a
    // clipped one is unreadable without the tooltip.
    expect(heading.getAttribute("title")).toBe("Asana");
    expect(screen.getByText("Clients")).toBeTruthy();
    expect(screen.getByTitle("Claude, Cursor")).toBeTruthy();
    expect(screen.getByText("claude-haiku-4.5 +1")).toBeTruthy();
    expect(screen.getByText("Prod · Claude")).toBeTruthy();
    // BB-202: the tab strip no longer gives way, so the heading is the child
    // that has to shrink.
    expect(heading.className.split(/\s+/)).toContain("truncate");
    expect(await screen.findByTestId("swarm-findings-tab")).toBeTruthy();
    expect(screen.queryByTestId("swarm-insights-statline")).toBeNull();
    expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Personas" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Findings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Insights" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeTruthy();
    expect(screen.queryByTestId("swarm-run-detail-view-run")).toBeNull();
    expect(screen.queryByTestId("swarm-run-detail-score")).toBeNull();
    expect(screen.queryByTestId("swarms-tab-header-chrome")).toBeNull();
  });

  it.each([
    ["Swarm · Nov 18", "Nov 18", false],
    ["Swarm · Checkout v2", undefined, true],
  ])("shows the name field for %s only when it is descriptive", async (swarmName, date, showName) => {
    const [newest, ...rest] = overview.runs;
    overviewData = {
      ...overview,
      runs: [{ ...newest!, swarmName }, ...rest],
    };
    renderTab("run-2b");
    expect(await screen.findByRole("heading", { name: "Asana" })).toBeTruthy();
    if (date) expect(screen.getAllByText(date)).toHaveLength(1);
    if (showName) {
      const metadata = screen.getByText("Clients").closest("dl");
      expect(screen.getByText(swarmName).closest("dl")).toBe(metadata);
      expect(screen.getByText("Name").closest("dl")).toBe(metadata);
    } else {
      expect(screen.queryByText("Name")).toBeNull();
      expect(screen.queryByText(swarmName)).toBeNull();
    }
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
      "https://app.test/swarms/run-2b?tab=findings"
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
    // The live watch surface, not the Sessions list minus a thread.
    expect(window.location.pathname).toBe("/swarms/run-2b");
    expect(window.location.search).toBe("?tab=run");
  });

  it("opens the live matrix and stream on a running wave with no tab", async () => {
    const [newest, second, ...rest] = overview.runs;
    overviewData = {
      ...overview,
      runs: [
        { ...newest!, status: "running" },
        { ...second!, status: "running" },
        ...rest,
      ],
    };
    renderTab("run-2b");

    expect(await screen.findByTestId("new-swarm-running-step")).toBeTruthy();
    expect(screen.getByTestId("new-swarm-running-stream")).toBeTruthy();
    expect(screen.queryByTestId("swarm-findings-tab")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Run" }).getAttribute("aria-current")
    ).toBe("page");
  });

  /**
   * BB-76: a run whose attempts are ALL terminal but whose row still says
   * `running` (the state `cancelJourneyRun` and the stale sweep both recompute
   * defensively for). The strip must not claim work is in flight when the
   * count it prints says otherwise.
   */
  it("stops claiming the wave is running once every session is accounted for", async () => {
    const [newest, second, ...rest] = overview.runs;
    overviewData = {
      ...overview,
      runs: [
        {
          ...newest!,
          status: "completed",
          summary: { total: 5, succeeded: 5, failed: 0, rateLimited: 0 },
        },
        {
          ...second!,
          status: "running",
          summary: { total: 15, succeeded: 14, failed: 1, rateLimited: 0 },
        },
        ...rest,
      ],
    };
    renderTab("run-2b");

    const live = await screen.findByTestId("swarm-run-detail-live");
    expect(live.textContent).toMatch(/Finishing up/);
    expect(live.textContent).not.toMatch(/still running/i);
    // The count itself stays honest — every session IS accounted for.
    expect(live.textContent).toMatch(/20 of 20 sessions/);
  });

  /**
   * The `total > 0` guard carries this: a run that has not published its
   * fan-out yet reads 0 done of 0, which satisfies `done >= total` on its own.
   * Calling that "finishing" would announce the end of work never started.
   */
  it("still reads as running when the fan-out is not known yet", async () => {
    const [newest, second, ...rest] = overview.runs;
    const noFanOut = { total: 0, succeeded: 0, failed: 0, rateLimited: 0 };
    overviewData = {
      ...overview,
      runs: [
        { ...newest!, status: "running", summary: noFanOut },
        { ...second!, status: "running", summary: noFanOut },
        ...rest,
      ],
    };
    renderTab("run-2b");

    const live = await screen.findByTestId("swarm-run-detail-live");
    expect(live.textContent).toMatch(/still running/i);
    expect(live.textContent).not.toMatch(/Finishing up/);
    // No fan-out to report, so the count is omitted rather than reading 0 of 0.
    expect(live.textContent).not.toMatch(/sessions/);
  });

  it("shows no live strip once every run in the wave is terminal", async () => {
    renderTab("run-2b");
    await screen.findByTestId("swarm-run-detail");
    expect(screen.queryByTestId("swarm-run-detail-live")).toBeNull();
  });

  it("opens the matrix from the Run tab on a finished wave", async () => {
    renderTab("run-2b");
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    expect(window.location.search).toBe("?tab=run");
    expect(await screen.findByTestId("new-swarm-running-step")).toBeTruthy();
    expect(screen.getByTestId("new-swarm-running-stream")).toBeTruthy();
  });

  it("does not show rubric findings on the Insights tab", async () => {
    renderTab("run-2b");
    await screen.findByTestId("swarm-run-detail");
    fireEvent.click(screen.getByRole("button", { name: "Insights" }));
    expect(screen.queryByTestId("swarm-overview-wave-findings")).toBeNull();
    expect(screen.queryByTestId("swarm-overview-finding")).toBeNull();
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
  const HEADLINE =
    "No recruiting, no scheduling, no setup. Agents find what breaks in every client.";

  it("keeps tabs inline and shows the headline on the empty state", async () => {
    personasData = [];
    renderTab();
    await screen.findByTestId("swarms-empty-hero");
    const header = screen.getByTestId("swarms-tab-header-chrome");
    const title = within(header).getByRole("heading", { name: "Swarm" });
    const row = within(header).getByTestId("swarms-tab-header-chrome-title-row");
    expect(row).toContainElement(title);
    expect(row).toContainElement(
      within(header).getByRole("button", { name: "Overview" }),
    );
    expect(screen.getByText(HEADLINE)).toBeTruthy();
  });

  it("keeps that chrome once the project has personas and runs", async () => {
    renderTab();
    await screen.findByTestId("swarm-overview-runs");
    expect(screen.queryByTestId("swarms-empty-hero")).toBeNull();
    expect(screen.getByText(HEADLINE)).toBeTruthy();
    expect(
      screen.queryByText("The library of user personas you send into swarms."),
    ).toBeNull();
  });
});

/**
 * BB-74 — run state and navigation.
 *
 * Four failures in one flow, all of them about losing the thread of a run:
 * following a live finding was a one-way trip, the way back did nothing
 * visible, a returning viewer could not tell a live run from a finished one and
 * could not stop one, and the launch confirmation reported an internal count
 * instead of taking anyone to the run.
 */
describe("Swarm run state and navigation", () => {
  /** The wave under `/swarms/run-2b`, with every run still going. */
  function runningOverview(): SwarmOverview {
    const [newest, second, ...rest] = overview.runs;
    return {
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
  }

  it("restores a pending Stop request after refresh", async () => {
    const current = runningOverview();
    overviewData = {
      ...current,
      runs: current.runs.map((run) => ({
        ...run,
        cancelRequested: true,
        cleanupPending: true,
      })),
    };
    renderTab("run-2b");
    expect(
      (await screen.findByTestId("swarm-run-detail-state-label")).textContent,
    ).toBe("Stop requested");
    expect(
      screen.getByTestId("swarm-run-detail-stop").hasAttribute("disabled"),
    ).toBe(true);
  });

  it("shows an uncanceled failure after another goal stops", async () => {
    const current = runningOverview();
    overviewData = {
      ...current,
      runs: current.runs.map((run, index) => ({
        ...run,
        status: "failed",
        cancelRequested: index === 0,
        cleanupPending: false,
      })),
    };
    renderTab("run-2b");
    expect(
      (await screen.findByTestId("swarm-run-detail-state-label")).textContent,
    ).toBe("Completed with issues");
  });

  it("restores Stopped after settlement without a local Stop click", async () => {
    overviewData = {
      ...overview,
      runs: overview.runs.map((run) => ({
        ...run,
        status: "failed",
        cancelRequested: true,
        cleanupPending: false,
      })),
    };
    renderTab("run-2b");
    expect(
      (await screen.findByTestId("swarm-run-detail-state-label")).textContent,
    ).toBe("Stopped");
  });

  it("reports Stop acceptance while background cleanup is pending", async () => {
    overviewData = runningOverview();
    mutationResult = (name) =>
      name === "journeyRuns:cancelJourneyRun"
        ? {
            canceled: true,
            cleanupPending: true,
            status: "running",
            finalized: 0,
          }
        : {};
    renderTab("run-2b");
    await screen.findByTestId("swarm-run-detail-live");
    fireEvent.click(screen.getByTestId("swarm-run-detail-stop"));
    fireEvent.click(await screen.findByTestId("swarm-run-detail-stop-confirm"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Stop requested"),
    );
  });

  it("omits the Complete badge and tally on a successful run", async () => {
    renderTab("run-2b");
    expect(await screen.findByTestId("swarm-run-detail-title")).toBeTruthy();
    expect(screen.queryByTestId("swarm-run-detail-state")).toBeNull();
    expect(screen.queryByTestId("swarm-run-detail-live")).toBeNull();
  });

  it("closes the focused session when the viewer goes back to the run", async () => {
    // THE reported bug: the button vanished and the session stayed on screen,
    // because the panel seeded its selection from the URL once and never
    // followed it again.
    window.history.replaceState(
      {},
      "",
      "/swarms/run-2b?tab=sessions&session=thread-fail"
    );
    renderTab("run-2b");

    expect(await screen.findByTestId("viewer")).toBeTruthy();

    fireEvent.click(screen.getByTestId("swarm-run-detail-back-to-run"));

    expect(window.location.search).toBe("?tab=sessions");
    await waitFor(() => expect(screen.queryByTestId("viewer")).toBeNull());
  });

  it("offers the way back out of a session on a run that has already finished", async () => {
    // The control existed only inside the live strip, so a finding followed
    // after the run settled was a dead end.
    window.history.replaceState(
      {},
      "",
      "/swarms/run-2b?tab=sessions&session=thread-fail"
    );
    renderTab("run-2b");

    const back = await screen.findByTestId("swarm-run-detail-back-to-run");
    expect(back.textContent).toMatch(/back to the run/i);
  });

  it("names the finding the viewer followed in on", async () => {
    window.history.replaceState(
      {},
      "",
      "/swarms/run-2b?tab=sessions&session=thread-fail&finding=crit-quick"
    );
    renderTab("run-2b");

    const banner = await screen.findByTestId(
      "swarm-run-detail-followed-finding"
    );
    expect(banner.getAttribute("data-criterion-id")).toBe("crit-quick");
    expect(banner.textContent).toMatch(/Quick resolution/);
    expect(banner.textContent).toMatch(/failed in 4 of 6 graded sessions/);
  });

  it("shows no finding banner for a criterion this wave does not carry", async () => {
    // The URL carries an id, not a sentence, so an unknown or renamed criterion
    // degrades to silence rather than to a stale claim.
    window.history.replaceState(
      {},
      "",
      "/swarms/run-2b?tab=sessions&session=thread-fail&finding=crit-gone"
    );
    renderTab("run-2b");

    await screen.findByTestId("swarm-run-detail");
    expect(
      screen.queryByTestId("swarm-run-detail-followed-finding")
    ).toBeNull();
  });

  it("stops every running goal in the wave, once confirmed", async () => {
    overviewData = runningOverview();
    renderTab("run-2b");

    await screen.findByTestId("swarm-run-detail-live");
    fireEvent.click(screen.getByTestId("swarm-run-detail-stop"));
    fireEvent.click(await screen.findByTestId("swarm-run-detail-stop-confirm"));

    await waitFor(() =>
      expect(
        mutationCalls.filter((c) => c.name === "journeyRuns:cancelJourneyRun")
      ).toHaveLength(2)
    );
    // Both goals in the wave, by run id — a wave is N runs and the backend
    // cancels one per call.
    expect(
      mutationCalls
        .filter((c) => c.name === "journeyRuns:cancelJourneyRun")
        .map((c) => (c.args as { journeyRunId: string }).journeyRunId)
        .sort()
    ).toEqual(["run-2", "run-2b"].sort());
    expect(toast.success).toHaveBeenCalledWith("Run stopped");
  });

  it("does not stop anything until the confirmation is taken", async () => {
    overviewData = runningOverview();
    renderTab("run-2b");

    await screen.findByTestId("swarm-run-detail-live");
    fireEvent.click(screen.getByTestId("swarm-run-detail-stop"));

    // A stop cannot be undone — the queued sessions never run — so the trigger
    // opens a confirmation rather than firing.
    await screen.findByTestId("swarm-run-detail-stop-confirm");
    expect(
      mutationCalls.filter((c) => c.name === "journeyRuns:cancelJourneyRun")
    ).toHaveLength(0);
  });

  it("reports a stop it could not make instead of claiming the run stopped", async () => {
    overviewData = runningOverview();
    mutationResult = (name) => {
      if (name === "journeyRuns:cancelJourneyRun") {
        throw new Error("Run already completed; only a running run can be canceled.");
      }
      return {};
    };
    renderTab("run-2b");

    await screen.findByTestId("swarm-run-detail-live");
    fireEvent.click(screen.getByTestId("swarm-run-detail-stop"));
    fireEvent.click(await screen.findByTestId("swarm-run-detail-stop-confirm"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Run already completed; only a running run can be canceled."
      )
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("says Stopped, not Completed with issues, to the viewer who stopped the run", async () => {
    overviewData = runningOverview();
    renderTab("run-2b");

    await screen.findByTestId("swarm-run-detail-live");
    fireEvent.click(screen.getByTestId("swarm-run-detail-stop"));
    fireEvent.click(await screen.findByTestId("swarm-run-detail-stop-confirm"));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    // The wave settles the way a canceled run settles — `failed`, because the
    // marker that separates a stop from a failure is not projected onto this
    // read. Painting that red to the person who just pressed Stop says their
    // action broke something.
    overviewData = {
      ...overview,
      runs: overview.runs.map((run) =>
        run.runId === "run-2" || run.runId === "run-2b"
          ? { ...run, status: "failed" }
          : run
      ),
    };
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));

    const state = await screen.findByTestId("swarm-run-detail-state");
    expect(state.getAttribute("data-run-state")).toBe("stopped");
    expect(
      screen.getByTestId("swarm-run-detail-state-label").textContent
    ).toBe("Stopped");
  });

  it("does not call a run that finished on its own a failure to stop", async () => {
    overviewData = runningOverview();
    // The real shape: Convex redacts `message` for an application error and
    // puts the payload on `data`, so only the structured code is readable.
    mutationResult = (name) => {
      if (name === "journeyRuns:cancelJourneyRun") {
        throw Object.assign(new Error("[Request ID: abc123] Server Error"), {
          data: {
            code: "CONFLICT",
            message: "Run already completed; only a running run can be canceled.",
          },
        });
      }
      return {};
    };
    renderTab("run-2b");

    await screen.findByTestId("swarm-run-detail-live");
    fireEvent.click(screen.getByTestId("swarm-run-detail-stop"));
    fireEvent.click(await screen.findByTestId("swarm-run-detail-stop-confirm"));

    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    // Not an error — nothing is running, which is what was asked for. And not
    // a success either: this viewer did not stop it, so the strip must keep
    // reporting the run's own outcome.
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();

    overviewData = {
      ...overview,
      runs: overview.runs.map((run) =>
        run.runId === "run-2" || run.runId === "run-2b"
          ? { ...run, status: "failed" }
          : run
      ),
    };
    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    const state = await screen.findByTestId("swarm-run-detail-state");
    expect(state.getAttribute("data-run-state")).not.toBe("stopped");
  });

  it("reports a refusal even when another goal settled on its own", async () => {
    overviewData = runningOverview();
    // A mixed wave: one goal finished between the click and the call, the
    // other genuinely refused. Reading the settled case first turned that
    // refusal into "Run had already finished".
    mutationResult = (name, args) => {
      if (name !== "journeyRuns:cancelJourneyRun") return {};
      const { journeyRunId } = args as { journeyRunId: string };
      if (journeyRunId === "run-2") {
        throw Object.assign(new Error("[Request ID: abc123] Server Error"), {
          data: {
            code: "CONFLICT",
            message: "Run already completed; only a running run can be canceled.",
          },
        });
      }
      throw Object.assign(new Error("[Request ID: def456] Server Error"), {
        data: { code: "FORBIDDEN", message: "Not a member of this project." },
      });
    };
    renderTab("run-2b");

    await screen.findByTestId("swarm-run-detail-live");
    fireEvent.click(screen.getByTestId("swarm-run-detail-stop"));
    fireEvent.click(await screen.findByTestId("swarm-run-detail-stop-confirm"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Not a member of this project.")
    );
    // The goal that had already finished is not a goal that "could not be
    // stopped", but it must not swallow the one that really refused.
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not carry one wave's stop onto the next wave", async () => {
    overviewData = runningOverview();
    const { rerender } = renderTab("run-2b");

    await screen.findByTestId("swarm-run-detail-live");
    fireEvent.click(screen.getByTestId("swarm-run-detail-stop"));
    fireEvent.click(await screen.findByTestId("swarm-run-detail-stop-confirm"));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    // The route this PR builds: Run again, then "View run". Same component
    // instance, different wave — the stop belonged to the wave left behind.
    overviewData = {
      ...overview,
      runs: overview.runs.map((run) =>
        run.runId === "run-2" || run.runId === "run-2b"
          ? { ...run, status: "failed" }
          : run
      ),
    };
    rerender(
      <SwarmsTab projectId="proj-1" isAuthenticated swarmId="run-1" />
    );

    const state = await screen.findByTestId("swarm-run-detail-state");
    expect(state.getAttribute("data-run-state")).not.toBe("stopped");
  });

  it("labels live runs in history and only shows the completed count for settled runs", async () => {
    overviewData = runningOverview();
    renderTab();
    await screen.findByTestId("swarm-overview-runs");
    expect(within(waveRow("run-2b")).getByText("Running")).toBeTruthy();
    expect(within(waveRow("run-1")).getByText("12 sessions")).toBeTruthy();
    expect(within(waveRow("run-1")).queryByText("Completed with issues")).toBeNull();
  });

  // The dot, not every round thing on the row — the targets pill is also
  // `rounded-full` and is staying.
  it("leaves no coloured status dot on the rows", async () => {
    renderTab();

    await screen.findByTestId("swarms-overview-panel");
    const row = waveRow("run-2b");
    expect(row.querySelectorAll("span.size-2.rounded-full")).toHaveLength(0);
    expect(row.innerHTML).not.toMatch(/bg-(red|amber|emerald)-500\b/);
  });
});
