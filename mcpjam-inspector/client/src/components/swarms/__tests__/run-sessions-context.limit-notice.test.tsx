import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import type { JourneyRun } from "@/lib/swarm-api";
import type { SwarmStreamEvent } from "@/shared/swarm-stream-events";

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  runs: { current: [] as unknown[] },
}));

vi.mock("@/lib/swarm-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swarm-api")>()),
  streamJourneyRun: mocks.stream,
}));

// The runs list is the paginated query keyed by the journey; every other
// paginated read (the run's sessions) is empty.
vi.mock("convex/react", () => ({
  usePaginatedQuery: (_query: unknown, args: Record<string, unknown>) => ({
    results: "journeyRefId" in args ? mocks.runs.current : [],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
  useQuery: () => undefined,
}));

import { RunSessionsProvider } from "../run-sessions-context";

const EXHAUSTED =
  "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.";

const runWith = (over: Partial<JourneyRun>): JourneyRun => ({
  _id: "run-1",
  status: "running",
  summary: { total: 1, succeeded: 0, failed: 0, rateLimited: 0 },
  hostSummaries: [],
  swarmRunGroupId: "wave-1",
  createdAt: 1,
  ...over,
});

function mount(run: JourneyRun, organizationId: string | undefined) {
  mocks.runs.current = [run];
  return render(
    <RunSessionsProvider
      runId={run._id}
      runSnapshot={run}
      journeyRefId="journey-1"
      hosts={[]}
      sessionsPerTarget={1}
      organizationId={organizationId}
    >
      {null}
    </RunSessionsProvider>,
  );
}

beforeEach(() => {
  mocks.stream.mockReset();
  mocks.stream.mockImplementation(() => new Promise(() => {}));
  useMCPJamLimitDialogStore.setState({
    notifiedKeys: new Set<string>(),
    staleWaveKeys: new Set<string>(),
    runKeysAtPurchase: {},
    waveOrganizations: {},
    authStatus: "signedIn",
    hasPendingLimit: false,
    outOfCreditsHit: false,
    outOfCreditsOrganizationId: null,
    isOpen: false,
    intent: null,
    organizationId: null,
    surface: null,
    period: null,
    shortfall: null,
    pendingInput: null,
  });
});

// The run detail knows the active organization the way the running step does.
// A wave whose notices never named one is treated as the buyer's by whichever
// organization starts a checkout next, so its next run reopens the dialog for
// an organization whose balance did not change.
describe("RunSessionsProvider limit notices", () => {
  it("names the organization on a persisted attempt's refusal", () => {
    mount(
      runWith({
        attempts: [
          {
            chatSessionId: null,
            hostId: "host-1",
            targetId: null,
            sessionIdx: 0,
            status: "rate_limited",
            errorCode: "user_rate_limit",
            errorMessage: EXHAUSTED,
          },
        ],
      }),
      "org-a",
    );

    expect(useMCPJamLimitDialogStore.getState()).toMatchObject({
      isOpen: true,
      organizationId: "org-a",
      outOfCreditsOrganizationId: "org-a",
      waveOrganizations: { "wave:wave-1": "org-a" },
    });
  });

  it("names the organization on a refusal that arrives on the run's stream", () => {
    let emit: (event: SwarmStreamEvent) => void = () => {};
    mocks.stream.mockImplementation((_id, onEvent) => {
      emit = onEvent;
      return new Promise(() => {});
    });
    mount(runWith({ attempts: [] }), "org-a");
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);

    act(() =>
      emit({
        runId: "run-1",
        hostId: "host-1",
        sessionIndex: 0,
        chatSessionId: "blocked",
        type: "attempt_status",
        status: "failed",
        errorMessage: EXHAUSTED,
      }),
    );
    expect(useMCPJamLimitDialogStore.getState()).toMatchObject({
      isOpen: true,
      organizationId: "org-a",
      waveOrganizations: { "wave:wave-1": "org-a" },
    });
  });

  it("leaves the wave unowned when the tab has no organization", () => {
    mount(
      runWith({
        attempts: [
          {
            chatSessionId: null,
            hostId: "host-1",
            targetId: null,
            sessionIdx: 0,
            status: "rate_limited",
            errorCode: "user_rate_limit",
            errorMessage: EXHAUSTED,
          },
        ],
      }),
      undefined,
    );

    expect(useMCPJamLimitDialogStore.getState()).toMatchObject({
      isOpen: true,
      organizationId: null,
      waveOrganizations: {},
    });
  });
});
