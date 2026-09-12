/**
 * SUTB-15 regression: one swarm across TWO per-client environments.
 *
 * This is the shape the report described — an environment per client (ChatGPT,
 * Claude), one swarm over both — and it is the supported modern usage since
 * journeys became environments-only. The pieces are each covered elsewhere
 * (`SwarmsTab.createFlow` pins the multi-env stamp), and nothing covered the
 * ONE launch that carries both at once.
 *
 * Two properties, both about what leaves the client:
 *   1. every write and every launch carries BOTH environment ids;
 *   2. an environment that does not resolve fails the whole launch with a
 *      sentence naming what to do, rather than silently producing a
 *      single-client swarm the user believes is a comparison.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => false,
  useSkillsEnabledState: () => false,
}));

vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
  useComputersEnabledState: () => false,
}));

vi.mock("@/hooks/useSandboxImages", () => ({
  useSandboxImages: () => [],
}));

const HOSTS = [
  { hostId: "host-gpt", name: "ChatGPT" },
  { hostId: "host-claude", name: "Claude" },
];

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: HOSTS, isLoading: false }),
}));

vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => <div data-testid="server-group-picker" />,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
  useDbUserBootstrapStatus: () => ({
    isUserReady: true,
    isEnsuringUser: false,
  }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "user-1@example.com" },
  }),
}));

const { environmentsRef, createEnvironmentMock, ensureAdhocEnvironmentsMock } =
  vi.hoisted(() => ({
    createEnvironmentMock: vi.fn(),
    ensureAdhocEnvironmentsMock: vi.fn(),
    environmentsRef: {
      current: [] as Array<Record<string, unknown>>,
    },
  }));

vi.mock("@/hooks/useProjectEnvironments", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/hooks/useProjectEnvironments")
  >();
  return {
    ...actual,
    useCreateProjectEnvironment: () => createEnvironmentMock,
    useEnsureAdhocEnvironments: () => ensureAdhocEnvironmentsMock,
    useProjectEnvironments: () => environmentsRef.current,
  };
});

vi.mock("@/components/swarms/use-journey-run-stream", () => ({
  useJourneyRunStream: () => ({
    sessions: {},
    cellStatus: {},
    runComplete: false,
    connected: false,
    error: null,
  }),
  liveSessionTrace: () => null,
  swarmCellKey: (targetKey: string, sessionIndex: number) =>
    `${targetKey}:${sessionIndex}`,
}));

const createSwarmMock = vi.fn();
const createPersonaMock = vi.fn();
const createJourneyMock = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return [];
      case "journeys:listJourneysByPersona":
        return [];
      case "journeyRuns:getJourneyRun":
        return null;
      case "hosts:listHosts":
        return HOSTS;
      case "projectEnvironments:listEnvironments":
        return environmentsRef.current;
      case "serverInspections:getEnvironmentToolInventory":
        return {
          environmentName: "ChatGPT prod",
          serverCount: 2,
          toolCount: 7,
          capturedAt: 1_700_000_000_000,
        };
      default:
        return undefined;
    }
  },
  useMutation: (name: string) => {
    if (name === "swarms:createSwarm") return createSwarmMock;
    if (name === "personas:createPersona") return createPersonaMock;
    if (name === "journeys:createJourney") return createJourneyMock;
    if (name === "projectEnvironments:createEnvironment") {
      return createEnvironmentMock;
    }
    return vi.fn().mockResolvedValue(undefined);
  },
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useDbUserReady: () => true,
}));

const generateSwarmPersonaBatchMock = vi.fn();
const launchJourneyRunMock = vi.fn();

vi.mock("@/lib/swarm-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarm-api")>();
  return {
    ...actual,
    launchJourneyRun: (...args: unknown[]) => launchJourneyRunMock(...args),
    generateSwarmPersonaBatch: (...args: unknown[]) =>
      generateSwarmPersonaBatchMock(...args),
  };
});

vi.mock("@/components/swarms/SwarmsSessionsPanel", () => ({
  SwarmsSessionsPanel: () => <div data-testid="sessions-panel" />,
}));

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));

vi.mock("@/lib/scenario-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));

vi.mock("@/lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-navigation")>();
  return { ...actual, useAppNavigate: () => vi.fn() };
});

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/project-environments/environment-picker", () => ({
  EnvironmentPicker: ({
    value,
    onChange,
    triggerTestId,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
    triggerTestId?: string;
  }) => (
    <button
      type="button"
      data-testid={triggerTestId ?? "environments-picker"}
      onClick={() => {
        // One click per client, the way the picker's checkboxes read:
        // [] → [ChatGPT] → [ChatGPT, Claude].
        if (value.length === 0) onChange(["env-gpt"]);
        else if (value.length === 1) onChange(["env-gpt", "env-claude"]);
        else onChange([]);
      }}
    >
      {value.length ? `${value.length} env` : "pick env"}
    </button>
  ),
}));

import { SwarmsTab } from "../SwarmsTab";

/** Both per-client environments, as the Environments page saved them. */
function perClientEnvironments() {
  return [
    {
      environmentId: "env-gpt",
      projectId: "proj-1",
      name: "ChatGPT prod",
      hostId: "host-gpt",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      environmentId: "env-claude",
      projectId: "proj-1",
      name: "Claude prod",
      hostId: "host-claude",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
}

/** Describe with a paragraph and BOTH per-client environments selected. */
function describeAcrossBothClients() {
  render(<SwarmsTab projectId="proj-1" isAuthenticated createFlow />);
  fireEvent.change(screen.getByTestId("new-swarm-describe-input"), {
    target: { value: "Finance ops reconciling payouts" },
  });
  const picker = screen.getByTestId("new-swarm-environments-picker");
  // Auto-seed already has env-gpt; one click adds env-claude.
  fireEvent.click(picker);
  expect(picker).toHaveTextContent("2 env");
}

beforeEach(() => {
  vi.clearAllMocks();
  // The flow mirrors its resumable state into sessionStorage, so a leftover
  // draft would otherwise resume the previous case's slate.
  sessionStorage.clear();
  environmentsRef.current = perClientEnvironments();
  let personaSeq = 0;
  let journeySeq = 0;
  createSwarmMock.mockImplementation(async () => ({ _id: "swarm-1" }));
  createPersonaMock.mockImplementation(async () => ({
    _id: `persona-${++personaSeq}`,
  }));
  createJourneyMock.mockImplementation(async () => ({
    _id: `journey-${++journeySeq}`,
  }));
  launchJourneyRunMock.mockImplementation(async () => ({
    runId: `run-${++journeySeq}`,
  }));
  generateSwarmPersonaBatchMock.mockResolvedValue({
    personas: [
      {
        persona: { name: "Refund Chaser", role: "Support agent" },
        journeys: [{ name: "Refund a charge", goal: "Refund the charge" }],
      },
      {
        persona: { name: "Billing Dev", role: "Engineer wiring billing" },
        journeys: [{ goal: "Wire up the subscription webhook" }],
      },
    ],
  });
});

describe("SwarmsTab — a swarm across two per-client environments", () => {
  it("launches both environments on one wave", async () => {
    describeAcrossBothClients();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    // Both clients are named on Confirm, and the session count is the
    // per-environment count TIMES the environments — the number the user
    // approves before spending anything.
    expect(screen.getByTestId("new-swarm-confirm-clients")).toHaveTextContent(
      "ChatGPT prod · Claude prod"
    );
    expect(
      screen.getByTestId("new-swarm-launch-session-estimate"),
    ).toHaveTextContent(/4 sessions/i);
    expect(
      screen.queryByTestId("new-swarm-grading-toggle"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(createJourneyMock).toHaveBeenCalledTimes(2));
    // The swarm row records where the wave ran.
    expect(createSwarmMock.mock.calls[0][0]).toMatchObject({
      environmentIds: ["env-gpt", "env-claude"],
    });
    expect(createSwarmMock.mock.calls[0][0]).not.toHaveProperty("judgeConfig");
    // Every created journey is born with the full fan-out. An env-based
    // journey stores no host list.
    for (const [args] of createJourneyMock.mock.calls) {
      expect(args.environmentIds).toEqual(["env-gpt", "env-claude"]);
      expect(args.hostIds).toEqual([]);
      expect("judgeConfig" in args).toBe(false);
      expect("rubric" in args).toBe(false);
    }

    // One launch per journey, each in the same wave, and no per-run override:
    // the journeys already carry the selection, so restating it would be one.
    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(2));
    const waveIds = new Set(
      launchJourneyRunMock.mock.calls.map((call) => call[0].swarmRunGroupId)
    );
    expect(waveIds.size).toBe(1);
    for (const [args] of launchJourneyRunMock.mock.calls) {
      expect("environmentIds" in args).toBe(false);
    }
    await screen.findByTestId("new-swarm-running-step");
  });

  it("refuses the whole launch when one of the two environments is gone", async () => {
    // The failure mode the report is most likely to have hit: one of the pair
    // never made it (a save that failed, an archive). A launch that quietly
    // dropped it would produce a single-client swarm presented as a
    // comparison, so it fails with a sentence naming the fix — and writes
    // nothing.
    environmentsRef.current = [perClientEnvironments()[0]];
    describeAcrossBothClients();

    fireEvent.click(screen.getByTestId("new-swarm-continue"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no longer available\. Remove it and pick another/i
    );
    expect(generateSwarmPersonaBatchMock).not.toHaveBeenCalled();
    expect(createSwarmMock).not.toHaveBeenCalled();
    expect(createJourneyMock).not.toHaveBeenCalled();
    expect(launchJourneyRunMock).not.toHaveBeenCalled();
  });
});
