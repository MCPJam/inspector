/**
 * SUTB-15 regression: one swarm across TWO per-client environments, graded by a
 * GPT-4 judge.
 *
 * This is the shape the report described — an environment per client (ChatGPT,
 * Claude), one swarm over both, a scoring rubric on a GPT-4 model — and it is
 * the supported modern usage since journeys became environments-only. The
 * pieces are each covered elsewhere (`SwarmsTab.createFlow` pins the multi-env
 * stamp; `judges-section` pins the toggle), and nothing covered the ONE launch
 * that carries both at once. That combination is what a fan-out bug and a
 * grading bug would have shared, so it is what a regression has to reproduce.
 *
 * Two properties, both about what leaves the client:
 *   1. every write and every launch carries BOTH environment ids, and the judge
 *      the author picked rides on the swarm row and on each created journey —
 *      grading a two-client comparison on one model is the entire point;
 *   2. an environment that does not resolve fails the whole launch with a
 *      sentence naming what to do, rather than silently producing a
 *      single-client swarm the user believes is a comparison.
 *
 * `JourneyRubricEditor` is stubbed to one button (the real predicate editor is
 * `ChecksSection`'s own test's job); the judge picker is NOT stubbed, because
 * the model id it emits is the thing under test.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Predicate } from "@/shared/eval-matching";

const CRITERION: Predicate = {
  type: "toolCalledAtLeastOnce",
  toolName: "search",
};

/** The GPT-4 model the report's author reached for, plus the managed default. */
const GPT_4_MODEL_ID = "openai/gpt-4.1";

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({
    availableModels: [
      { id: GPT_4_MODEL_ID, name: "GPT-4.1", provider: "openai" },
      { id: "openai/gpt-5.4-mini", name: "GPT-5.4 mini", provider: "openai" },
    ],
  }),
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

vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => <div data-testid="server-group-picker" />,
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

vi.mock("@/components/swarms/journey-rubric-editor", () => ({
  JourneyRubricEditor: ({
    value,
    onChange,
  }: {
    value: Array<{ id: string; predicate: Predicate }>;
    onChange: (next: Array<{ id: string; predicate: Predicate }>) => void;
  }) => (
    <button
      type="button"
      onClick={() => onChange([{ id: "crit-1", predicate: CRITERION }])}
    >
      add criterion ({value.length})
    </button>
  ),
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
  it("launches both environments and grades them on the chosen GPT-4 judge", async () => {
    const user = userEvent.setup();
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

    // Attach the rubric: a deterministic check plus the LLM judge, moved off
    // the managed default onto a GPT-4 model.
    fireEvent.click(screen.getByTestId("new-swarm-grading-toggle"));
    fireEvent.click(screen.getByRole("button", { name: /add criterion/i }));
    await user.click(
      screen.getByRole("switch", { name: /auto-grade every session/i })
    );
    await user.click(screen.getByRole("combobox", { name: "Judge model" }));
    await user.click(screen.getByRole("option", { name: "GPT-4.1" }));

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(createJourneyMock).toHaveBeenCalledTimes(2));
    const judgeConfig = {
      goalCompletion: {
        enabled: true,
        autoRun: true,
        judgeModel: GPT_4_MODEL_ID,
      },
    };
    // The swarm row records where the wave ran and how it is graded.
    expect(createSwarmMock.mock.calls[0][0]).toMatchObject({
      environmentIds: ["env-gpt", "env-claude"],
      judgeConfig,
    });
    // Every created journey is born with the full fan-out and the same judge:
    // scores from the two clients are only comparable if one model produced
    // them, and an env-based journey stores no host list.
    for (const [args] of createJourneyMock.mock.calls) {
      expect(args.environmentIds).toEqual(["env-gpt", "env-claude"]);
      expect(args.hostIds).toEqual([]);
      expect(args.judgeConfig).toEqual(judgeConfig);
      expect(args.rubric).toHaveLength(1);
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
