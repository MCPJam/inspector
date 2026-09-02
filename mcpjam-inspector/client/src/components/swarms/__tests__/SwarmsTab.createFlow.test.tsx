/**
 * New swarm create flow: Describe → Confirm personas → Create & launch.
 *
 * The properties worth pinning are the ones that cost money or lose work:
 * nothing is written until Launch, every created journey carries the SAME
 * rubric ids, each journey is launched exactly once, and a partial failure
 * keeps what landed instead of unwinding it.
 *
 * `JourneyRubricEditor` is stubbed to a single button — driving the real
 * predicate editor would test `ChecksSection`, which has its own tests.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Predicate } from "@/shared/eval-matching";

const CRITERION: Predicate = {
  type: "toolCalledAtLeastOnce",
  toolName: "search",
};

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

/**
 * `project-environments-enabled`, as a ref: an org can hold Swarms without it
 * (the sidebar gates the two surfaces on different flags), and that
 * combination has its own case below.
 */
const { environmentsFlagRef } = vi.hoisted(() => ({
  environmentsFlagRef: { current: true },
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => environmentsFlagRef.current,
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

/**
 * Clients and the project server catalog, as refs: the cloud-reachability
 * preflight reads BOTH (a client's `serverCount`, and what those servers are),
 * so a case has to be able to re-point them. Defaults deliberately omit
 * `serverCount` — an older backend does, and "unknown" must not read as zero.
 */
const { hostsRef, projectServersRef } = vi.hoisted(() => ({
  hostsRef: {
    current: [
      { hostId: "host-1", name: "Claude" },
      { hostId: "host-2", name: "Cursor" },
    ] as Array<{ hostId: string; name: string; serverCount?: number }>,
  },
  projectServersRef: {
    current: [] as Array<{
      _id: string;
      name: string;
      command?: string;
      url?: string;
    }>,
  },
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: hostsRef.current,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [null, vi.fn()] as const,
}));

vi.mock("@/hooks/use-previewed-environment-id", () => ({
  usePreviewedEnvironmentId: () => [null, vi.fn()] as const,
}));

vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => <div data-testid="server-group-picker" />,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

const {
  createEnvironmentMock,
  ensureAdhocEnvironmentsMock,
  environmentsRef,
  setInsightsTuningMock,
  insightsTuningRef,
} = vi.hoisted(() => ({
  createEnvironmentMock: vi.fn(),
  ensureAdhocEnvironmentsMock: vi.fn(),
  setInsightsTuningMock: vi.fn().mockResolvedValue(undefined),
  /** What `getSwarmInsightsTuning` returns; a ref so a case can re-point it. */
  insightsTuningRef: {
    current: {
      tuning: { maxClusters: 8, minSeparation: 0.15, linkThreshold: 0.78 },
      source: "defaults",
    } as { tuning: Record<string, number>; source: string } | undefined,
  },
  environmentsRef: {
    current: [] as Array<{
      environmentId: string;
      projectId: string;
      name: string;
      hostId: string;
      revision: number;
    }>,
  },
}));

vi.mock("@/hooks/useProjectEnvironments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useProjectEnvironments")>();
  return {
    ...actual,
    useCreateProjectEnvironment: () => createEnvironmentMock,
    useEnsureAdhocEnvironments: () => ensureAdhocEnvironmentsMock,
    useProjectEnvironments: () => environmentsRef.current,
  };
});

// Kept in sync with environmentsRef for the Convex listEnvironments mock.
let environments = environmentsRef.current;

let existingPersonas: Array<Record<string, unknown>> = [];
let personaJourneys: Array<Record<string, unknown>> = [];

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

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return existingPersonas;
      case "journeys:listJourneysByPersona":
        return personaJourneys;
      case "journeyRuns:getJourneyRun":
        // Running step resolves the launched run by id; undefined = loading.
        // Tests that need live cells can stub a concrete run here.
        return null;
      case "hosts:listHosts":
        return [
          { hostId: "host-1", name: "Claude" },
          { hostId: "host-2", name: "Cursor" },
        ];
      case "projectEnvironments:listEnvironments":
        return environments;
      case "serverInspections:getEnvironmentToolInventory":
        return {
          environmentName: "Prod-like",
          serverCount: 2,
          toolCount: 7,
          capturedAt: 1_700_000_000_000,
        };
      case "chatSessions:getSwarmInsightsTuning":
        return insightsTuningRef.current;
      default:
        return undefined;
    }
  },
  useMutation: (name: string) => {
    if (name === "swarms:createSwarm") return createSwarmMock;
    if (name === "personas:createPersona") return createPersonaMock;
    if (name === "journeys:createJourney") return createJourneyMock;
    if (name === "journeys:updateJourney") return updateJourneyMock;
    if (name === "personas:updatePersona") return updatePersonaMock;
    if (name === "projectEnvironments:createEnvironment") {
      return createEnvironmentMock;
    }
    if (name === "chatSessions:setSwarmInsightsTuning") {
      return setInsightsTuningMock;
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
  useProjectServers: () => ({
    servers: projectServersRef.current,
    isLoading: false,
  }),
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

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
// The create flow is entered and left by NAVIGATION now (`/swarms/new`), not
// by in-page state, so the entry/exit assertions need the navigate call.
vi.mock("@/lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-navigation")>();
  return { ...actual, useAppNavigate: () => navigateMock };
});

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
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
        // Cycle [] → [env-1] → [env-1, env-2] → [] so multi-env launch is testable.
        if (value.length === 0) onChange(["env-1"]);
        else if (value.length === 1) onChange(["env-1", "env-2"]);
        else onChange([]);
      }}
    >
      {value.length ? `${value.length} env` : "pick env"}
    </button>
  ),
}));

const createSwarmMock = vi.fn();
const createPersonaMock = vi.fn();
const createJourneyMock = vi.fn();
const updateJourneyMock = vi.fn();
const updatePersonaMock = vi.fn();

import { SwarmsTab } from "../SwarmsTab";
// Real class (the `swarm-api` mock spreads the original), so the `instanceof`
// branch the 402 handling turns on is the one under test.
import { LaunchJourneyRunError } from "@/lib/swarm-api";
import { toast } from "@/lib/toast";

/**
 * Attach an existing persona.
 *
 * The list moved behind "Add existing personas" (BB-121), so the popover has to
 * be opened first. It stays open across a multi-select, hence the guard rather
 * than an unconditional click — a second click would close it.
 */
function pickExistingPersona(name: RegExp) {
  if (!screen.queryByRole("checkbox", { name })) {
    fireEvent.click(screen.getByTestId("new-swarm-add-existing-personas"));
  }
  fireEvent.click(screen.getByRole("checkbox", { name }));
}

function openDescribe() {
  // `/swarms/new` is what opens the flow — mount it the way the router does.
  render(<SwarmsTab projectId="proj-1" isAuthenticated createFlow />);
}

function submitLaunchEnabled() {
  return !(screen.getByTestId("new-swarm-launch") as HTMLButtonElement)
    .disabled;
}

function fillDescribe(text = "Support agents answering refunds") {
  fireEvent.change(screen.getByTestId("new-swarm-describe-input"), {
    target: { value: text },
  });
  // Auto-seed usually already picked the first named environment; only click
  // when the picker is still empty (e.g. compose-only fixtures).
  const picker = screen.getByTestId("new-swarm-environments-picker");
  if (picker.textContent === "pick env") {
    fireEvent.click(picker);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  environmentsFlagRef.current = true;
  // The flow now mirrors its resumable state into sessionStorage, so a leftover
  // draft would otherwise resume the previous case's slate.
  sessionStorage.clear();
  hostsRef.current = [
    { hostId: "host-1", name: "Claude" },
    { hostId: "host-2", name: "Cursor" },
  ];
  projectServersRef.current = [];
  existingPersonas = [];
  personaJourneys = [];
  // Ad-hoc rows carry NO name — the shape the flag-on path has to cope with.
  ensureAdhocEnvironmentsMock.mockImplementation(
    async (args: { stacks: Array<{ hostId: string }> }) =>
      args.stacks.map((stack) => ({
        environment: {
          environmentId: `adhoc-${stack.hostId}`,
          projectId: "proj-1",
          hostId: stack.hostId,
          origin: "adhoc",
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        created: true,
      })),
  );
  createEnvironmentMock.mockImplementation(
    async (args: { hostId: string; name: string }) => ({
      environmentId: `created-${args.hostId}`,
      projectId: "proj-1",
      name: args.name,
      hostId: args.hostId,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  environmentsRef.current = [
    {
      environmentId: "env-1",
      projectId: "proj-1",
      name: "Prod-like",
      hostId: "host-1",
      revision: 1,
    },
    {
      environmentId: "env-2",
      projectId: "proj-1",
      name: "Amazon",
      hostId: "host-2",
      revision: 1,
    },
  ];
  environments = environmentsRef.current;
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
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
  }));
  updateJourneyMock.mockResolvedValue(undefined);
  updatePersonaMock.mockResolvedValue(undefined);
  generateSwarmPersonaBatchMock.mockResolvedValue({
    personas: [
      {
        persona: { name: "Refund Chaser", role: "Support agent", notes: "n1" },
        journeys: [{ name: "Refund a charge", goal: "Refund the charge" }],
      },
      {
        persona: { name: "Billing Dev", role: "Engineer wiring billing" },
        journeys: [{ goal: "Wire up the subscription webhook" }],
      },
    ],
  });
});

describe("SwarmsTab — New swarm create flow", () => {
  it("reaches the create flow by its own route, and Cancel leaves it", () => {
    // A linkable route rather than in-page state, so the browser back button
    // exits the flow and a reload doesn't drop the user back on the list.
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(
      within(screen.getByTestId("swarms-tab-header-chrome")).getByRole(
        "button",
        { name: /^create new swarm$/i },
      ),
    );
    expect(navigateMock).toHaveBeenCalledWith("/swarms/new");
    // Still on the list: navigation is what swaps the view, not a state flip.
    expect(
      screen.queryByTestId("new-swarm-create-flow"),
    ).not.toBeInTheDocument();

    cleanup();
    navigateMock.mockClear();
    openDescribe();

    expect(screen.getByTestId("new-swarm-create-flow")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: /create an agentic swarm/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("swarms-tab-header-chrome"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(navigateMock).toHaveBeenCalledWith("/swarms");
  });

  it("starts a fresh flow from 'Create new swarm' even when a previous launch left a draft", () => {
    // Leaving the Running step via the sidebar (not Leave) keeps the flow's
    // sessionStorage draft, so `/swarms/new` would resume the old swarm.
    sessionStorage.setItem(
      "mcp-new-swarm-flow-draft",
      JSON.stringify({
        version: 1,
        projectId: "proj-1",
        savedAt: Date.now(),
        draft: { step: "running", launchedRuns: [] },
      }),
    );
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(
      within(screen.getByTestId("swarms-tab-header-chrome")).getByRole(
        "button",
        { name: /^create new swarm$/i },
      ),
    );
    expect(navigateMock).toHaveBeenCalledWith("/swarms/new");
    expect(sessionStorage.getItem("mcp-new-swarm-flow-draft")).toBeNull();

    cleanup();
    openDescribe();
    expect(screen.getByTestId("new-swarm-create-flow")).toBeInTheDocument();
    expect(screen.queryByText(/swarming/i)).not.toBeInTheDocument();
  });

  it("keeps the action disabled until there is something to act on, and says why", () => {
    openDescribe();
    const submit = screen.getByTestId("new-swarm-continue");
    expect(submit).toBeDisabled();
    expect(screen.getByText(/describe your users to continue/i)).toBeVisible();

    // Targets are auto-seeded; a description is the remaining gate for generate.
    fireEvent.change(screen.getByTestId("new-swarm-describe-input"), {
      target: { value: "Support agents answering refunds" },
    });
    expect(submit).not.toBeDisabled();
    expect(submit).toHaveTextContent("Continue");
    expect(screen.getByText(/3 new personas on next step/i)).toBeVisible();
  });

  it("auto-seeds the first named environment on open", () => {
    openDescribe();
    expect(
      screen.getByTestId("new-swarm-environments-picker"),
    ).toHaveTextContent("1 env");
    expect(screen.getByTestId("new-swarm-clients-picker")).toHaveTextContent(
      /claude/i,
    );
    expect(
      screen.getByText(/grounded on 7 tools from prod-like/i),
    ).toBeVisible();
  });

  // The two sources used to be labelled "Optional" each, so a user with an
  // untouched form faced a disabled Continue with nothing claiming to be
  // required. The pair is the choice; the button's blocker names itself.
  it("labels the two persona sources as one required choice, and points Continue at its blocker", () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    openDescribe();

    // One label covers both sources and carries the required marker, so an
    // untouched form no longer shows a disabled Continue with nothing on
    // screen claiming to be required.
    expect(
      screen.getByText(/describe your users or bring in existing personas/i),
    ).toBeVisible();
    expect(screen.queryByText(/optional/i)).not.toBeInTheDocument();

    const submit = screen.getByTestId("new-swarm-continue");
    const hint = screen.getByTestId("new-swarm-continue-hint");
    expect(submit).toBeDisabled();
    expect(hint).toBeVisible();
    expect(hint).toHaveTextContent(/describe your users, or pick a persona/i);
    expect(submit).toHaveAttribute(
      "aria-describedby",
      "new-swarm-continue-hint",
    );
  });

  /**
   * SUTB-5. Both reporters wrote personas and goals first and only then met
   * `ENV_NO_SERVERS` from the resolver — one with an empty client, one with a
   * local (stdio) server a cloud run can't reach. The flow has to refuse BEFORE
   * anything is written, and say which of the two it is: "connect a server" and
   * "make the server you have reachable" are different fixes.
   */
  it("refuses to continue when the target has no servers, and names the reason", () => {
    hostsRef.current = [
      { hostId: "host-1", name: "Claude", serverCount: 0 },
      { hostId: "host-2", name: "Cursor", serverCount: 0 },
    ];
    openDescribe();
    fillDescribe();

    expect(screen.getByTestId("new-swarm-continue")).toBeDisabled();
    expect(
      screen.getByTestId("new-swarm-server-unreachable"),
    ).toHaveTextContent(/prod-like has no servers to run against/i);
    expect(screen.getByText(/fix where it runs to continue/i)).toBeVisible();
    expect(createSwarmMock).not.toHaveBeenCalled();
  });

  it("refuses to continue when the target's only server is local-only", () => {
    hostsRef.current = [
      { hostId: "host-1", name: "Claude", serverCount: 1 },
      { hostId: "host-2", name: "Cursor", serverCount: 1 },
    ];
    projectServersRef.current = [
      { _id: "srv-1", name: "Fetch", command: "uvx" },
    ];
    openDescribe();
    fillDescribe();

    expect(screen.getByTestId("new-swarm-continue")).toBeDisabled();
    const notice = screen.getByTestId("new-swarm-server-unreachable");
    expect(notice).toHaveTextContent(/has servers this run can't reach/i);
    expect(notice).toHaveTextContent(/Fetch/);
  });

  it("continues when the target's server is cloud-reachable", () => {
    hostsRef.current = [
      { hostId: "host-1", name: "Claude", serverCount: 1 },
      { hostId: "host-2", name: "Cursor", serverCount: 1 },
    ];
    projectServersRef.current = [
      { _id: "srv-1", name: "Notion", url: "https://mcp.notion.com/mcp" },
    ];
    openDescribe();
    fillDescribe();

    expect(screen.getByTestId("new-swarm-continue")).not.toBeDisabled();
    expect(
      screen.queryByTestId("new-swarm-server-unreachable"),
    ).not.toBeInTheDocument();
  });

  it("lets a returning user continue on personas alone — no description, no environment, no generation", async () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      { _id: "j-existing", name: "Reconcile payouts", goal: "Reconcile" },
    ];
    openDescribe();

    const submit = screen.getByTestId("new-swarm-continue");
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(/describe your users, or pick a persona/i),
    ).toBeVisible();
    expect(screen.getByTestId("new-swarm-describe-step")).toBeInTheDocument();

    pickExistingPersona(/include ana/i);
    expect(submit).not.toBeDisabled();
    expect(submit).toHaveTextContent("Continue");
    expect(screen.getByText(/1 persona selected/i)).toBeVisible();

    fireEvent.click(submit);

    // Straight to Confirm with no model call and nothing to create.
    await screen.findByTestId("new-swarm-reused-personas");
    expect(generateSwarmPersonaBatchMock).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("new-swarm-proposed-personas"),
    ).not.toBeInTheDocument();

    await waitFor(() => expect(submitLaunchEnabled()).toBe(true));
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    expect(createPersonaMock).not.toHaveBeenCalled();
    expect(createJourneyMock).not.toHaveBeenCalled();
    expect(launchJourneyRunMock.mock.calls[0][0].journeyId).toBe("j-existing");
    await screen.findByTestId("new-swarm-running-step");
  });

  it("returns to Describe when its stepper step is clicked from Confirm", async () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      { _id: "j-existing", name: "Reconcile payouts", goal: "Reconcile" },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");

    fireEvent.click(
      screen.getByRole("button", { name: /^back to describe$/i }),
    );

    expect(screen.getByTestId("new-swarm-describe-step")).toBeInTheDocument();
    expect(
      screen.queryByTestId("new-swarm-reused-personas"),
    ).not.toBeInTheDocument();
  });

  it("drops a failed launch's error when Back returns to Describe", async () => {
    // The error belongs to the attempt the user just left. Describe renders
    // `errorMessage` too, so keeping it makes the step the user landed on look
    // like it failed — and nothing on Describe can dismiss it.
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      { _id: "j-existing", name: "Reconcile payouts", goal: "Reconcile" },
    ];
    launchJourneyRunMock.mockRejectedValue(new Error("Launch was rejected"));
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    await waitFor(() => expect(submitLaunchEnabled()).toBe(true));

    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no runs were launched/i,
    );

    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));

    expect(screen.getByTestId("new-swarm-describe-step")).toBeInTheDocument();
    expect(
      screen.queryByText(/no runs were launched/i),
    ).not.toBeInTheDocument();
  });

  it("expands persona detail inline from a compact card", async () => {
    existingPersonas = [
      {
        _id: "p-1",
        personaId: "p1",
        name: "Ana",
        role: "Ops",
        notes: "Closes the books monthly.",
      },
    ];
    personaJourneys = [
      { _id: "j-existing", name: "Reconcile payouts", goal: "Reconcile" },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");

    expect(
      screen.queryByTestId("new-swarm-persona-detail"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("new-swarm-persona-compact"));

    const detail = await screen.findByTestId("new-swarm-persona-detail");
    expect(within(detail).getByText(/use cases & context/i)).toBeVisible();
    // Every field is a control now (BB-122) — the goal and the context read
    // back as values, not as text nodes.
    expect(within(detail).getByDisplayValue("Reconcile payouts")).toBeVisible();
    expect(
      within(detail).getByDisplayValue(/closes the books monthly/i),
    ).toBeVisible();
  });

  it("edits an existing persona's goal in place and saves it explicitly", async () => {
    existingPersonas = [
      {
        _id: "p-1",
        personaId: "p1",
        name: "Ana",
        role: "Ops",
        notes: "Closes the books monthly.",
      },
    ];
    personaJourneys = [
      {
        _id: "j-existing",
        name: "Reconcile payouts",
        goal: "Reconcile",
        hostIds: ["host-1"],
        environmentIds: ["env-1"],
        config: { sessionsPerTarget: 1, maxTurns: 6 },
      },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    fireEvent.click(screen.getByTestId("new-swarm-persona-compact"));
    const detail = await screen.findByTestId("new-swarm-persona-detail");

    const save = within(detail).getByTestId("new-swarm-persona-save");
    fireEvent.change(within(detail).getByDisplayValue("Reconcile payouts"), {
      target: { value: "Reconcile payouts weekly" },
    });
    expect(navigateMock).not.toHaveBeenCalledWith("/swarms?persona=p-1");

    fireEvent.click(save);

    await vi.waitFor(() => {
      expect(updateJourneyMock).toHaveBeenCalled();
    });
    expect(updateJourneyMock.mock.calls[0][0]).toMatchObject({
      journeyRefId: "j-existing",
      goal: "Reconcile payouts weekly",
    });
    // The persona row itself did not change, so it is left alone.
    expect(updatePersonaMock).not.toHaveBeenCalled();
  });

  it("writes nothing when Save is pressed on an untouched existing persona", async () => {
    // The row is shared with every other swarm reusing it, so a no-op Save
    // must not bump its updatedAt for all of them — it just closes.
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      {
        _id: "j-existing",
        name: "Reconcile payouts",
        goal: "Reconcile",
        hostIds: ["host-1"],
        environmentIds: ["env-1"],
        config: { sessionsPerTarget: 1, maxTurns: 6 },
      },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    fireEvent.click(screen.getByTestId("new-swarm-persona-compact"));
    const detail = await screen.findByTestId("new-swarm-persona-detail");

    fireEvent.click(within(detail).getByTestId("new-swarm-persona-save"));

    await vi.waitFor(() => {
      expect(
        screen.queryByTestId("new-swarm-persona-detail"),
      ).not.toBeInTheDocument();
    });
    expect(updatePersonaMock).not.toHaveBeenCalled();
    expect(updateJourneyMock).not.toHaveBeenCalled();
  });

  it("saves an existing persona's own fields, sending only what moved", async () => {
    existingPersonas = [
      {
        _id: "p-1",
        personaId: "p1",
        name: "Ana",
        role: "Ops",
        notes: "Closes the books monthly.",
      },
    ];
    personaJourneys = [
      {
        _id: "j-existing",
        name: "Reconcile payouts",
        goal: "Reconcile",
        hostIds: ["host-1"],
        environmentIds: ["env-1"],
        config: { sessionsPerTarget: 1, maxTurns: 6 },
      },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    fireEvent.click(screen.getByTestId("new-swarm-persona-compact"));
    const detail = await screen.findByTestId("new-swarm-persona-detail");

    fireEvent.change(within(detail).getByLabelText("Persona role"), {
      target: { value: "Finance ops" },
    });
    fireEvent.click(within(detail).getByTestId("new-swarm-persona-save"));

    await vi.waitFor(() => {
      expect(updatePersonaMock).toHaveBeenCalled();
    });
    const patch = updatePersonaMock.mock.calls[0][0];
    expect(patch).toMatchObject({ personaRefId: "p-1", role: "Finance ops" });
    // Untouched fields stay off the wire entirely.
    expect(patch.name).toBeUndefined();
    expect(patch.notes).toBeUndefined();
    // The goal never moved, so no journey write either.
    expect(updateJourneyMock).not.toHaveBeenCalled();
  });

  it("summarizes the combined result when both doors are used", () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    openDescribe();
    fillDescribe();
    pickExistingPersona(/include ana/i);

    expect(screen.getByTestId("new-swarm-continue")).toHaveTextContent(
      "Continue",
    );
    expect(screen.getByText(/1 existing · 3 new on next step/i)).toBeVisible();
  });

  it("scales the session estimate with the number of environments", () => {
    openDescribe();
    const quick = screen.getByRole("radio", { name: /quick look/i });
    // Auto-seed picks one env: 3 personas × 5 journeys × 1 session.
    expect(quick).toHaveTextContent("15 sessions");
    expect(
      screen.getByRole("radio", { name: /launch gate/i }),
    ).toHaveTextContent("120 sessions");

    // Second env doubles the fan-out.
    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    expect(quick).toHaveTextContent("30 sessions");
    expect(
      screen.getByRole("radio", { name: /launch gate/i }),
    ).toHaveTextContent("240 sessions");
  });

  it("shows the grounding hint for the auto-seeded environment", () => {
    openDescribe();
    expect(
      screen.getByText(/grounded on 7 tools from prod-like/i),
    ).toBeVisible();
  });

  it("hides the existing-personas row when the project has none", () => {
    openDescribe();
    expect(
      screen.queryByTestId("new-swarm-existing-personas"),
    ).not.toBeInTheDocument();
  });

  it("passes selected existing personas as dedup hints", async () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    openDescribe();
    fillDescribe();

    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));

    await waitFor(() =>
      expect(generateSwarmPersonaBatchMock).toHaveBeenCalled(),
    );
    expect(generateSwarmPersonaBatchMock.mock.calls[0][0]).toMatchObject({
      projectId: "proj-1",
      environmentId: "env-1",
      personaCount: 3,
      journeyCount: 5,
      description: "Support agents answering refunds",
      existingPersonas: [{ name: "Ana", role: "Ops" }],
    });
  });

  it("writes nothing until Launch, then creates personas, journeys, and one run each", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));

    await screen.findByTestId("new-swarm-proposed-personas");
    // Generation alone must not touch the database.
    expect(createPersonaMock).not.toHaveBeenCalled();
    expect(createJourneyMock).not.toHaveBeenCalled();
    expect(screen.getByText("Refund Chaser")).toBeInTheDocument();
    expect(screen.getByText("Billing Dev")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(2));
    expect(createPersonaMock).toHaveBeenCalledTimes(2);
    expect(createPersonaMock.mock.calls[0][0]).toMatchObject({
      projectId: "proj-1",
      source: "generated",
      name: "Refund Chaser",
      role: "Support agent",
      notes: "n1",
    });
    expect(createJourneyMock).toHaveBeenCalledTimes(2);
    expect(createJourneyMock.mock.calls[0][0]).toMatchObject({
      projectId: "proj-1",
      personaRefId: "persona-1",
      name: "Refund a charge",
      goal: "Refund the charge",
      environmentIds: ["env-1"],
      config: { sessionsPerTarget: 1, maxTurns: 6 },
    });
    // The confirm step seeds the universal starter checks, so an untouched
    // launch stamps exactly those; the judge stays opt-in (uses credits).
    expect(
      (
        createJourneyMock.mock.calls[0][0].rubric as Array<{
          predicate: { type: string };
        }>
      ).map((entry) => entry.predicate),
    ).toEqual([
      { type: "noToolErrors" },
      { type: "finalAssistantMessageNonEmpty" },
    ]);
    expect(createJourneyMock.mock.calls[0][0]).not.toHaveProperty(
      "judgeConfig",
    );

    // Distinct idempotency keys — one run per journey, never a shared key.
    const keys = launchJourneyRunMock.mock.calls.map(
      (call) => call[0].launchKey,
    );
    expect(new Set(keys).size).toBe(2);
    // Launch stays in the wizard on the live matrix; Leave hands the user off
    // to the Sessions view. That handoff is a route change now, and `?view=`
    // carries the landing view so reloading that URL lands there too.
    await screen.findByTestId("new-swarm-running-step");
    expect(screen.getByText(/Refund Chaser/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("new-swarm-running-stop"));
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/swarms?view=sessions"),
    );
  });

  it("removing a persona on Confirm drops its journeys from the launch", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(
      screen.getByRole("button", { name: /remove persona billing dev/i }),
    );
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    expect(createPersonaMock).toHaveBeenCalledTimes(1);
    expect(createJourneyMock).toHaveBeenCalledTimes(1);
  });

  it("stamps suggested checks onto their own journey only, on top of the starters", async () => {
    generateSwarmPersonaBatchMock.mockResolvedValue({
      personas: [
        {
          persona: {
            name: "Refund Chaser",
            role: "Support agent",
            notes: "n1",
          },
          journeys: [
            {
              name: "Refund a charge",
              goal: "Refund the charge",
              suggestedChecks: [
                { type: "toolCalledAtLeastOnce", toolName: "refund_charge" },
              ],
            },
          ],
        },
        {
          persona: { name: "Billing Dev", role: "Engineer wiring billing" },
          journeys: [{ goal: "Wire up the subscription webhook" }],
        },
      ],
    });
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    // The suggestion is visible (and prunable) with its journey's goal.
    fireEvent.click(screen.getAllByTestId("new-swarm-persona-compact")[0]);
    expect(screen.getByTestId("new-swarm-journey-check")).toHaveTextContent(
      "Calls refund_charge",
    );

    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    await waitFor(() => expect(createJourneyMock).toHaveBeenCalledTimes(2));

    const rubricByGoal = new Map(
      createJourneyMock.mock.calls.map((call) => [
        call[0].goal as string,
        call[0].rubric as Array<{
          label?: string;
          predicate: Predicate;
        }>,
      ]),
    );
    expect(
      rubricByGoal.get("Refund the charge")!.map((row) => row.predicate),
    ).toEqual([
      { type: "noToolErrors" },
      { type: "finalAssistantMessageNonEmpty" },
      { type: "toolCalledAtLeastOnce", toolName: "refund_charge" },
    ]);
    expect(rubricByGoal.get("Refund the charge")![2].label).toBe(
      "Calls refund_charge",
    );
    // The unrelated journey must NOT carry the refund check — it could never
    // pass there and would read as a regression.
    expect(
      rubricByGoal
        .get("Wire up the subscription webhook")!
        .map((row) => row.predicate),
    ).toEqual([
      { type: "noToolErrors" },
      { type: "finalAssistantMessageNonEmpty" },
    ]);
  });

  it("a pruned suggested check is not stamped", async () => {
    generateSwarmPersonaBatchMock.mockResolvedValue({
      personas: [
        {
          persona: {
            name: "Refund Chaser",
            role: "Support agent",
            notes: "n1",
          },
          journeys: [
            {
              goal: "Refund the charge",
              suggestedChecks: [
                { type: "toolCalledAtLeastOnce", toolName: "refund_charge" },
              ],
            },
          ],
        },
      ],
    });
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(screen.getAllByTestId("new-swarm-persona-compact")[0]);
    fireEvent.click(
      screen.getByRole("button", { name: /remove check calls refund_charge/i }),
    );
    expect(
      screen.queryByTestId("new-swarm-journey-check"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    await waitFor(() => expect(createJourneyMock).toHaveBeenCalledTimes(1));
    const rubric = createJourneyMock.mock.calls[0][0].rubric as Array<{
      predicate: Predicate;
    }>;
    expect(rubric.map((row) => row.predicate)).toEqual([
      { type: "noToolErrors" },
      { type: "finalAssistantMessageNonEmpty" },
    ]);
  });

  it("stamps one rubric, with identical ids, onto every created journey", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(screen.getByTestId("new-swarm-grading-toggle"));
    fireEvent.click(screen.getByRole("button", { name: /add criterion/i }));
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(createJourneyMock).toHaveBeenCalledTimes(2));
    const rubrics = createJourneyMock.mock.calls.map((call) => call[0].rubric);
    // Shared ids are what let Findings roll a criterion up across the swarm.
    expect(rubrics[0]).toEqual([{ id: "crit-1", predicate: CRITERION }]);
    expect(rubrics[1]).toEqual(rubrics[0]);
  });

  it("keeps journeys that landed when one write fails, and reports the failure", async () => {
    createJourneyMock
      .mockRejectedValueOnce(new Error("Journey rejected"))
      .mockResolvedValueOnce({ _id: "journey-2" });
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    // The surviving journey still launches — a failed sibling doesn't unwind it.
    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    expect(createPersonaMock).toHaveBeenCalledTimes(2);
  });

  it("summarizes a credit limit as the credit limit, not as whatever failed first", async () => {
    // Launches run concurrently, so an unrelated failure can settle BEFORE the
    // 402. The wave still stops for billing, and the summary has to say so:
    // rendering the transient reason under "Launched N of M" reads as "retry
    // the rest", which is exactly what a credit limit cannot fix.
    generateSwarmPersonaBatchMock.mockResolvedValue({
      personas: [
        {
          persona: { name: "Refund Chaser", role: "Support agent" },
          journeys: [{ goal: "Refund the charge" }],
        },
        {
          persona: { name: "Billing Dev", role: "Engineer wiring billing" },
          journeys: [{ goal: "Wire up the subscription webhook" }],
        },
        {
          persona: { name: "Ops Lead", role: "Runs the on-call rotation" },
          journeys: [{ goal: "Page the on-call engineer" }],
        },
      ],
    });
    let seq = 0;
    launchJourneyRunMock.mockImplementation(async () => {
      seq += 1;
      if (seq === 1) return { runId: "run-1" };
      if (seq === 2) throw new Error("upstream unavailable");
      throw new LaunchJourneyRunError(
        402,
        "Your organization's credit limit was reached.",
      );
    });

    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const summary = vi.mocked(toast.warning).mock.calls[0][0] as string;
    expect(summary).toContain("credit limit");
    expect(summary).not.toContain("upstream unavailable");
  });

  it("stays on Confirm with an explanation when no run launches", async () => {
    launchJourneyRunMock.mockRejectedValue(new Error("Out of credits"));
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no runs were launched/i,
    );
    expect(
      screen.queryByTestId("new-swarm-running-step"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("sessions-panel")).not.toBeInTheDocument();
  });

  it("retrying after a launch failure re-launches without re-creating rows", async () => {
    launchJourneyRunMock.mockRejectedValue(new Error("Out of credits"));
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /2 goals were created/i,
    );
    expect(createJourneyMock).toHaveBeenCalledTimes(2);

    // The personas and journeys are real rows now. A retry that re-ran
    // creation would silently double every one of them.
    let retrySeq = 0;
    launchJourneyRunMock.mockImplementation(async () => ({
      runId: `run-retry-${++retrySeq}`,
    }));
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(4));
    expect(createPersonaMock).toHaveBeenCalledTimes(2);
    expect(createJourneyMock).toHaveBeenCalledTimes(2);
    await screen.findByTestId("new-swarm-running-step");
  });

  it("surfaces a generation failure inline and stays on Describe", async () => {
    generateSwarmPersonaBatchMock.mockRejectedValue(
      new Error("You're out of credits"),
    );
    openDescribe();
    fillDescribe();

    fireEvent.click(screen.getByTestId("new-swarm-continue"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /out of credits/i,
    );
    expect(
      screen.queryByTestId("new-swarm-proposed-personas"),
    ).not.toBeInTheDocument();
  });

  it("launches a reused persona's journeys, re-stamped onto the selected environment", async () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      { _id: "j-existing", name: "Reconcile payouts", goal: "Reconcile" },
    ];
    generateSwarmPersonaBatchMock.mockResolvedValue({
      personas: [
        {
          persona: { name: "Refund Chaser", role: "Support agent" },
          journeys: [{ goal: "Refund the charge" }],
        },
      ],
    });
    openDescribe();
    fillDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    // Launch stays held until the reused persona's journeys have resolved —
    // launching early would silently omit them.
    await waitFor(() =>
      expect(screen.getByTestId("new-swarm-launch")).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(2));
    // One new journey created; the reused one is launched by id, with the env
    // selection riding as a RUN parameter (it carried none of its own).
    expect(createJourneyMock).toHaveBeenCalledTimes(1);
    const reusedLaunch = launchJourneyRunMock.mock.calls
      .map((call) => call[0])
      .find((arg) => arg.journeyId === "j-existing");
    expect(reusedLaunch).toBeDefined();
    expect(reusedLaunch.environmentIds).toEqual(["env-1"]);
    // Its stored definition is NOT rewritten — only grading is ever patched.
    for (const call of updateJourneyMock.mock.calls) {
      expect("environmentIds" in call[0]).toBe(false);
      expect("hostIds" in call[0]).toBe(false);
    }
    await screen.findByTestId("new-swarm-running-step");
  });

  it("runs reused journeys on a newly selected multi-env fan-out without rewriting them", async () => {
    // The bug this pins: reuse Ana, check BOTH environments on Describe, and
    // the launch used to run her journeys untouched on their old single env —
    // a "2 envs selected" swarm that still produced single-client runs.
    //
    // The fix used to re-stamp her stored `environmentIds`, which changed the
    // journey for every future run and for everyone else. It now rides as a
    // run parameter, so the selection applies to THIS launch only.
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      {
        _id: "j-existing",
        name: "Reconcile payouts",
        goal: "Reconcile",
        environmentIds: ["env-1"],
      },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    // Auto-seed has [env-1]; one click adds env-2.
    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    await waitFor(() =>
      expect(screen.getByTestId("new-swarm-launch")).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    expect(launchJourneyRunMock.mock.calls[0][0].environmentIds).toEqual([
      "env-1",
      "env-2",
    ]);
    // The journey's own stored fan-out is left exactly as its author set it.
    for (const call of updateJourneyMock.mock.calls) {
      expect("environmentIds" in call[0]).toBe(false);
    }
    expect(createJourneyMock).not.toHaveBeenCalled();
    await screen.findByTestId("new-swarm-running-step");
  });

  it("sends no override when the reused journey already matches the selection", async () => {
    // An override restating the journey's own config is noise on the wire.
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      {
        _id: "j-existing",
        name: "Reconcile payouts",
        goal: "Reconcile",
        environmentIds: ["env-1"],
      },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    // Auto-seed already matches the journey's env-1 — no picker click needed.
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    await waitFor(() =>
      expect(screen.getByTestId("new-swarm-launch")).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    expect("environmentIds" in launchJourneyRunMock.mock.calls[0][0]).toBe(
      false,
    );
    await screen.findByTestId("new-swarm-running-step");
  });

  it("skips the env re-stamp when a reused journey already matches, but still merges grading", async () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      {
        _id: "j-existing",
        name: "Reconcile payouts",
        goal: "Reconcile",
        environmentIds: ["env-1"],
      },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    await waitFor(() =>
      expect(screen.getByTestId("new-swarm-launch")).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    // One call, carrying ONLY the rubric: the env selection already matches,
    // so nothing about the journey's fan-out is rewritten.
    expect(updateJourneyMock).toHaveBeenCalledTimes(1);
    const patch = updateJourneyMock.mock.calls[0][0];
    expect(patch.journeyRefId).toBe("j-existing");
    expect(
      patch.rubric.map(
        (c: { predicate: { type: string } }) => c.predicate.type,
      ),
    ).toEqual(["noToolErrors", "finalAssistantMessageNonEmpty"]);
    expect("environmentIds" in patch).toBe(false);
    expect("hostIds" in patch).toBe(false);
    // Never send judgeConfig when the author didn't set one — null/undefined
    // would clear the journey's own judge.
    expect("judgeConfig" in patch).toBe(false);
    await screen.findByTestId("new-swarm-running-step");
  });

  it("writes ONE swarm row and stamps it onto every created journey", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(2));
    expect(createSwarmMock).toHaveBeenCalledTimes(1);
    const swarmRefIds = createJourneyMock.mock.calls.map(
      (c) => c[0].swarmRefId,
    );
    expect(new Set(swarmRefIds).size).toBe(1);
    expect(swarmRefIds[0]).toBe("swarm-1");
  });

  it("derives stable idempotency keys so a retry replays instead of duplicating", async () => {
    // The keys are what stop a retry from creating a second persona and
    // journey per proposal — the create loop is client-side, so without them a
    // dropped response duplicates every row it already wrote.
    launchJourneyRunMock.mockRejectedValue(new Error("upstream unavailable"));
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");
    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    await screen.findByRole("alert");

    const swarmKey = createSwarmMock.mock.calls[0][0].idempotencyKey;
    const personaKeys = createPersonaMock.mock.calls.map(
      (c) => c[0].idempotencyKey,
    );
    const journeyKeys = createJourneyMock.mock.calls.map(
      (c) => c[0].idempotencyKey,
    );
    expect(swarmKey).toBeTruthy();
    // Distinct per row, so replay resolves each to its own record.
    expect(new Set(personaKeys).size).toBe(personaKeys.length);
    expect(new Set(journeyKeys).size).toBe(journeyKeys.length);
    // All share the one flow prefix.
    const flowId = swarmKey.split(":")[0];
    for (const key of [...personaKeys, ...journeyKeys]) {
      expect(key.startsWith(`${flowId}:`)).toBe(true);
    }

    // Retry: the rows already landed, so the flow only re-launches — but the
    // swarm step sits outside that short-circuit and must NOT create a second.
    launchJourneyRunMock.mockReset();
    let n = 0;
    launchJourneyRunMock.mockImplementation(async () => ({
      runId: `run-${(n += 1)}`,
    }));
    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    await waitFor(() =>
      expect(launchJourneyRunMock.mock.calls.length).toBeGreaterThan(0),
    );
    expect(createSwarmMock).toHaveBeenCalledTimes(1);
  });

  it("launches even when the swarm record could not be written", async () => {
    // The container is provenance. Refusing to run the swarm the user asked
    // for because a bookkeeping row failed would be the wrong trade.
    createSwarmMock.mockRejectedValue(new Error("swarm write failed"));
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(2));
    expect("swarmRefId" in createJourneyMock.mock.calls[0][0]).toBe(false);
    await screen.findByTestId("new-swarm-running-step");
  });

  it("stamps ONE wave id across every journey of a launch", async () => {
    // The whole point of the durable id: these runs are one swarm, and the
    // Overview must not have to infer that from how close their timestamps are.
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(2));
    const groupIds = launchJourneyRunMock.mock.calls.map(
      (c) => (c[0] as any).swarmRunGroupId,
    );
    expect(new Set(groupIds).size).toBe(1);
    expect(groupIds[0]).toBeTruthy();
    // Launch keys stay per-journey — grouping must not collapse idempotency.
    const launchKeys = launchJourneyRunMock.mock.calls.map(
      (c) => (c[0] as any).launchKey,
    );
    expect(new Set(launchKeys).size).toBe(2);
  });

  it("reuses the wave id when a failed launch is retried", async () => {
    // A partial-failure retry replays the already-launched journeys' keys and
    // gets back their ORIGINAL runs; minting a fresh wave would split one
    // user-visible swarm across two Overview rows.
    launchJourneyRunMock.mockRejectedValue(new Error("upstream unavailable"));
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");
    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    await screen.findByRole("alert");
    const firstGroupId = (launchJourneyRunMock.mock.calls[0]![0] as any)
      .swarmRunGroupId;

    launchJourneyRunMock.mockReset();
    let retryRun = 0;
    launchJourneyRunMock.mockImplementation(async () => ({
      runId: `run-retry-${(retryRun += 1)}`,
    }));
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() =>
      expect(launchJourneyRunMock.mock.calls.length).toBeGreaterThan(0),
    );
    expect(
      (launchJourneyRunMock.mock.calls[0]![0] as any).swarmRunGroupId,
    ).toBe(firstGroupId);
  });

  it("counts reused journeys in the session estimate", async () => {
    // The estimate used to count only newly authored journeys, so a
    // reuse-heavy swarm under-reported the work it was about to do.
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      { _id: "j-existing", name: "Reconcile payouts", goal: "Reconcile" },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");

    expect(
      await screen.findByText(/run 1 session total in this swarm/i),
    ).toBeInTheDocument();
  });

  it("keeps a reused journey's own sessions when the intensity changes", async () => {
    // SUTB-26: a preset may seed a field, never overwrite one the user set.
    // This journey was saved at 3 sessions and launch does not rewrite a
    // shared journey's config, so pushing harder must not re-price it.
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      {
        _id: "j-existing",
        name: "Reconcile payouts",
        goal: "Reconcile",
        config: { sessionsPerTarget: 3, maxTurns: 9 },
      },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    expect(
      await screen.findByText(/run 3 sessions total in this swarm/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /^back to describe$/i }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /launch gate/i }));
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");

    expect(
      await screen.findByText(/run 3 sessions total in this swarm/i),
    ).toBeInTheDocument();
  });

  it("merges swarm grading into a reused journey on a reuse-only launch", async () => {
    // No environment selection at all. The Confirm copy promises the merge
    // unconditionally, and shared criterion ids are what put this journey in
    // the swarm's Findings rollup.
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      { _id: "j-existing", name: "Reconcile payouts", goal: "Reconcile" },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    // Deliberately no environment picker clicks.
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    await waitFor(() =>
      expect(screen.getByTestId("new-swarm-launch")).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    expect(updateJourneyMock).toHaveBeenCalledTimes(1);
    const patch = updateJourneyMock.mock.calls[0][0];
    expect(patch.journeyRefId).toBe("j-existing");
    expect(patch.rubric).toHaveLength(2);
    expect("environmentIds" in patch).toBe(false);
    await screen.findByTestId("new-swarm-running-step");
  });

  it("still launches a reused journey when only the grading merge failed", async () => {
    // Grading is advisory — a failed rubric write must not drop the run the
    // user actually asked for (unlike a failed env re-stamp, below).
    updateJourneyMock.mockRejectedValue(new Error("rubric rejected"));
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      { _id: "j-existing", name: "Reconcile payouts", goal: "Reconcile" },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    await waitFor(() =>
      expect(screen.getByTestId("new-swarm-launch")).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    await screen.findByTestId("new-swarm-running-step");
  });

  it("surfaces a rejected environment override as a failed launch", async () => {
    // This used to be "don't launch a journey whose env re-stamp failed": the
    // selection was written to the definition first, so a bad environment had
    // to be caught there or the run would quietly use the old fan-out. Now the
    // selection IS the launch, so the backend rejects the launch itself and
    // there is no window in which a wrong-shaped run can start.
    launchJourneyRunMock.mockRejectedValue(new Error("environment archived"));
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    personaJourneys = [
      { _id: "j-existing", name: "Reconcile payouts", goal: "Reconcile" },
    ];
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    await waitFor(() =>
      expect(screen.getByTestId("new-swarm-launch")).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no runs were launched/i,
    );
    expect(
      screen.queryByTestId("new-swarm-running-step"),
    ).not.toBeInTheDocument();
  });

  it("holds Launch while a reused persona's journeys are still loading", async () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    // `undefined` is Convex's loading state — the card must not report an
    // empty target list for it.
    personaJourneys = undefined as never;
    generateSwarmPersonaBatchMock.mockResolvedValue({
      personas: [
        {
          persona: { name: "Refund Chaser", role: "Support agent" },
          journeys: [{ goal: "Refund the charge" }],
        },
      ],
    });
    openDescribe();
    fillDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");

    expect(screen.getByTestId("new-swarm-launch")).toBeDisabled();
  });

  it("stamps every selected environment onto created journeys", async () => {
    openDescribe();
    fillDescribe();
    // Auto-seed has env-1; one more click adds env-2.
    fireEvent.click(screen.getByTestId("new-swarm-environments-picker"));
    expect(
      screen.getByTestId("new-swarm-environments-picker"),
    ).toHaveTextContent("2 env");
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");
    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    await waitFor(() => expect(createJourneyMock).toHaveBeenCalled());
    expect(createJourneyMock.mock.calls[0][0].environmentIds).toEqual([
      "env-1",
      "env-2",
    ]);
    expect(createJourneyMock.mock.calls[0][0].hostIds).toEqual([]);
  });

  it("lets the user add a draft persona on Confirm and launch it with a goal", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    fireEvent.click(screen.getByTestId("new-swarm-add-persona"));
    expect(screen.getByDisplayValue("New persona")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("New persona"), {
      target: { value: "Manual Ops" },
    });
    fireEvent.change(screen.getByDisplayValue("Role"), {
      target: { value: "Operator" },
    });
    // New draft starts with one empty goal input.
    fireEvent.change(
      screen.getByPlaceholderText(/what should they try to do/i),
      {
        target: { value: "Resolve a stuck ticket" },
      },
    );

    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(3));
    expect(createPersonaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Manual Ops",
        role: "Operator",
      }),
    );
    expect(createJourneyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: "Resolve a stuck ticket",
      }),
    );
    await screen.findByTestId("new-swarm-running-step");
  });

  it("resolves composed clients into ad-hoc environments", async () => {
    environmentsRef.current = [];
    environments = environmentsRef.current;
    openDescribe();

    fireEvent.change(screen.getByTestId("new-swarm-describe-input"), {
      target: { value: "Support agents answering refunds" },
    });
    // No named envs → auto-seed picks Claude; add Cursor for a two-client fan-out.
    fireEvent.click(screen.getByTestId("new-swarm-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));

    fireEvent.click(screen.getByTestId("new-swarm-continue"));

    await waitFor(() =>
      expect(ensureAdhocEnvironmentsMock).toHaveBeenCalledTimes(1),
    );
    // One batch call for both clients, and no NAMED row is minted — the whole
    // point of the change is that Describe text never becomes an environment.
    expect(ensureAdhocEnvironmentsMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "host-1" }, { hostId: "host-2" }],
    });
    expect(createEnvironmentMock).not.toHaveBeenCalled();

    await screen.findByTestId("new-swarm-proposed-personas");
    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    await waitFor(() => expect(createJourneyMock).toHaveBeenCalled());
    expect(createJourneyMock.mock.calls[0][0].environmentIds).toEqual([
      "adhoc-host-1",
      "adhoc-host-2",
    ]);
  });

  it("mints ad-hoc rows for an org that has Swarms but not Environments", async () => {
    // THE regression. Ad-hoc rows are launch substrate and the backend leaves
    // them ungated; `createEnvironment` mints a NAMED row and is gated on
    // `project-environments-enabled`. Reading the flag here used to send
    // exactly the org that fails that gate down the naming path, so every
    // swarm launch died on "Environments is not currently available for your
    // organization" — with no saved environments to pick instead, the surface
    // was unusable rather than degraded.
    environmentsFlagRef.current = false;
    environmentsRef.current = [];
    environments = environmentsRef.current;
    openDescribe();

    // The describe box is a plain Textarea since BB-121; its accessible name is
    // the long visible label, so it is addressed by test id like the rest.
    fireEvent.change(screen.getByTestId("new-swarm-describe-input"), {
      target: { value: "Support agents answering refunds" },
    });
    fireEvent.click(screen.getByTestId("new-swarm-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));

    fireEvent.click(screen.getByTestId("new-swarm-continue"));

    await waitFor(() =>
      expect(ensureAdhocEnvironmentsMock).toHaveBeenCalledTimes(1),
    );
    expect(ensureAdhocEnvironmentsMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "host-1" }, { hostId: "host-2" }],
    });
    expect(createEnvironmentMock).not.toHaveBeenCalled();

    await screen.findByTestId("new-swarm-proposed-personas");
    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    await waitFor(() => expect(createJourneyMock).toHaveBeenCalled());
    expect(createJourneyMock.mock.calls[0][0].environmentIds).toEqual([
      "adhoc-host-1",
      "adhoc-host-2",
    ]);
  });

  it("falls back to NAMING rows on a backend with no ad-hoc mutation", async () => {
    // A desktop build can meet an arbitrarily old self-hosted backend, and this
    // is the only signal Convex gives for a missing function. The launch must
    // still complete, by the path it used before ad-hoc rows existed.
    ensureAdhocEnvironmentsMock.mockRejectedValue(
      Object.assign(new Error("Could not find public function"), {
        data: "Could not find public function for 'projectEnvironments:ensureAdhocEnvironments'",
      }),
    );
    environmentsRef.current = [];
    environments = environmentsRef.current;
    openDescribe();

    fireEvent.change(screen.getByTestId("new-swarm-describe-input"), {
      target: { value: "Support agents answering refunds" },
    });
    // Auto-seed already has Claude; add Cursor.
    fireEvent.click(screen.getByTestId("new-swarm-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));

    fireEvent.click(screen.getByTestId("new-swarm-continue"));

    await waitFor(() => expect(createEnvironmentMock).toHaveBeenCalledTimes(2));
    await screen.findByTestId("new-swarm-proposed-personas");
    expect(generateSwarmPersonaBatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "created-host-1",
      }),
    );

    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    await waitFor(() => expect(createJourneyMock).toHaveBeenCalled());
    expect(createJourneyMock.mock.calls[0][0].environmentIds).toEqual([
      "created-host-1",
      "created-host-2",
    ]);
    // Env-based journeys carry no derived host list.
    expect(createJourneyMock.mock.calls[0][0].hostIds).toEqual([]);
  });
});

/**
 * Insight grouping — the project-level clustering default, offered at the last
 * moment before the automatic post-run rebuild reads it.
 *
 * It sits in Shared setup but is NOT one of the target chips: those pin what
 * this swarm executes, while this reaches every swarm's insights in the
 * project. The copy has to say so, and the control has to save rather than
 * promise a rebuild that cannot happen yet.
 */
describe("SwarmsTab create flow — insight grouping", () => {
  it("offers the row in Shared setup and says the setting is project-wide", () => {
    openDescribe();
    const row = screen.getByTestId("new-swarm-insight-grouping");
    expect(
      within(row).getByTestId("cluster-tuning-trigger"),
    ).toBeInTheDocument();
    expect(row).toHaveTextContent(/Saved for this project/i);
  });

  it("saves rather than rebuilds, and never offers to re-analyze", async () => {
    const user = userEvent.setup();
    openDescribe();
    await user.click(
      within(screen.getByTestId("new-swarm-insight-grouping")).getByTestId(
        "cluster-tuning-trigger",
      ),
    );

    expect(screen.getByTestId("cluster-tuning-apply")).toHaveTextContent(
      "Save default",
    );
    // Nothing has run, so re-summarizing "every session" is not on offer.
    expect(
      screen.queryByTestId("cluster-tuning-force"),
    ).not.toBeInTheDocument();
  });

  it("writes the chosen preset to the project", async () => {
    const user = userEvent.setup();
    openDescribe();
    await user.click(
      within(screen.getByTestId("new-swarm-insight-grouping")).getByTestId(
        "cluster-tuning-trigger",
      ),
    );
    await user.click(screen.getByTestId("cluster-tuning-preset-detailed"));
    await user.click(screen.getByTestId("cluster-tuning-apply"));

    await waitFor(() => expect(setInsightsTuningMock).toHaveBeenCalled());
    expect(setInsightsTuningMock.mock.calls[0][0]).toEqual({
      projectId: "proj-1",
      tuning: { maxClusters: 16, minSeparation: 0.08, linkThreshold: 0.82 },
    });
  });

  it("seeds the control from what the project already uses", async () => {
    insightsTuningRef.current = {
      tuning: { maxClusters: 4, minSeparation: 0.25, linkThreshold: 0.72 },
      source: "project",
    };
    openDescribe();
    expect(
      within(screen.getByTestId("new-swarm-insight-grouping")).getByTestId(
        "cluster-tuning-trigger",
      ),
    ).toHaveTextContent("Broad");
  });
});

/**
 * Surviving a remount.
 *
 * The flow is remounted for reasons the user never asked for: the Swarms route
 * re-enters its role-gate spinner whenever the members query re-resolves, which
 * a Convex websocket reconnect (returning to a backgrounded tab does one) makes
 * happen. `cleanup()` + a fresh `render` is exactly that — the same URL mounting
 * a new component tree — and it used to land back on an empty Describe step with
 * the generated slate gone.
 */
describe("SwarmsTab create flow — survives a remount", () => {
  /** Unmount and mount the same route again, as a route-level gate would. */
  function remount() {
    cleanup();
    render(<SwarmsTab projectId="proj-1" isAuthenticated createFlow />);
  }

  it("keeps a name-only edit, and keeps its draft, across repeated remounts", async () => {
    // The regression: `hasResumableWork` compared the name against a ref
    // seeded from the RESTORED name, so after one remount an edited name read
    // as untouched, the draft was cleared, and the next remount fell back to
    // the date suggestion. Two remounts is what it takes to see it.
    openDescribe();
    fireEvent.change(screen.getByTestId("new-swarm-name"), {
      target: { value: "Billing swarm" },
    });

    remount();
    await screen.findByTestId("new-swarm-describe-step");
    expect(screen.getByTestId("new-swarm-name")).toHaveValue("Billing swarm");

    remount();
    await screen.findByTestId("new-swarm-describe-step");
    expect(screen.getByTestId("new-swarm-name")).toHaveValue("Billing swarm");
  });

  it("does not count the prefilled name as work of its own", async () => {
    // The other half of the same rule. The name field is PREFILLED, so a bare
    // non-empty check would make every fresh Describe step resumable. Asserted
    // through the flag rather than through the draft's absence, because target
    // auto-seeding already makes this fixture resumable on open.
    openDescribe();
    expect(
      (screen.getByTestId("new-swarm-name") as HTMLInputElement).value.length,
    ).toBeGreaterThan(0);

    const untouched = JSON.parse(
      sessionStorage.getItem("mcp-new-swarm-flow-draft") ?? "{}",
    );
    expect(untouched.draft?.nameEdited).toBe(false);

    fireEvent.change(screen.getByTestId("new-swarm-name"), {
      target: { value: "Billing swarm" },
    });
    const edited = JSON.parse(
      sessionStorage.getItem("mcp-new-swarm-flow-draft") ?? "{}",
    );
    expect(edited.draft?.nameEdited).toBe(true);
  });

  it("comes back on Confirm with the generated personas, not on Describe", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    remount();

    await screen.findByTestId("new-swarm-proposed-personas");
    expect(screen.getByText("Refund Chaser")).toBeInTheDocument();
    expect(screen.getByText("Billing Dev")).toBeInTheDocument();
    expect(
      screen.queryByTestId("new-swarm-describe-step"),
    ).not.toBeInTheDocument();
    // The slate is the restored one — nothing was re-generated behind the user.
    expect(generateSwarmPersonaBatchMock).toHaveBeenCalledTimes(1);
  });

  it("launches the restored slate without creating the rows twice", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    remount();
    await screen.findByTestId("new-swarm-proposed-personas");
    await waitFor(() => expect(submitLaunchEnabled()).toBe(true));
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(2));
    expect(createPersonaMock).toHaveBeenCalledTimes(2);
    expect(createJourneyMock).toHaveBeenCalledTimes(2);
  });

  it("comes back on the live matrix once runs are launched", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");
    fireEvent.click(screen.getByTestId("new-swarm-launch"));
    await screen.findByTestId("new-swarm-running-step");

    remount();

    await screen.findByTestId("new-swarm-running-step");
    expect(screen.getByText(/Refund Chaser/)).toBeInTheDocument();
    // Restoring must not re-launch what is already running.
    expect(launchJourneyRunMock).toHaveBeenCalledTimes(2);
  });

  it("says a generation was interrupted instead of looking untouched", async () => {
    // A generation in flight at unmount cannot be resumed — its request died
    // with the component — so the restored step has to explain itself.
    generateSwarmPersonaBatchMock.mockImplementation(
      () => new Promise(() => {}),
    );
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await waitFor(() =>
      expect(screen.getByTestId("new-swarm-generate-progress")).toBeVisible(),
    );

    remount();

    expect(
      await screen.findByText(/persona generation was interrupted/i),
    ).toBeVisible();
    expect(screen.getByTestId("new-swarm-describe-input")).toHaveValue(
      "Support agents answering refunds",
    );
  });

  it("leaving the flow ends it — a later visit starts clean", async () => {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");

    // Back to Describe, then Cancel out of the flow entirely.
    fireEvent.click(
      screen.getByRole("button", { name: /^back to describe$/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    remount();

    expect(screen.getByTestId("new-swarm-describe-step")).toBeInTheDocument();
    expect(
      screen.queryByTestId("new-swarm-proposed-personas"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("new-swarm-describe-input")).toHaveValue("");
  });

  it("says what stage it is in while generation runs", async () => {
    generateSwarmPersonaBatchMock.mockImplementation(
      () => new Promise(() => {}),
    );
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));

    const progress = await screen.findByTestId("new-swarm-generate-progress");
    // Quick look = 3 personas × 5 goals; the line names the work, not a fake ETA.
    await waitFor(() =>
      expect(progress).toHaveTextContent(
        /writing 3 personas with up to 5 goals each/i,
      ),
    );
  });
});

// BB-121: the redesigned Describe step. These cover what the redesign ADDED —
// the stepper, the required name, the scope control's copy, and the attached-
// persona rows — rather than restating the gating the suite already covers.
describe("SwarmsTab — Describe step (Production Redesign)", () => {
  it("leads with the stepper, Describe current and nothing clickable behind it", () => {
    openDescribe();

    const stepper = screen.getByTestId("new-swarm-progress");
    expect(stepper).toHaveTextContent("Describe");
    expect(stepper).toHaveTextContent("Confirm personas");
    expect(stepper).toHaveTextContent("Running");
    expect(stepper).toHaveTextContent("Findings");
    // Done is a state of Findings, not a fifth circle.
    expect(stepper).not.toHaveTextContent(/\bDone\b/);

    const current = within(stepper)
      .getAllByRole("listitem")
      .filter((item) => item.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Describe");
    // Step one: there is nothing completed to go back to.
    expect(within(stepper).queryAllByRole("button")).toHaveLength(0);
  });

  it("shows the redesigned title, subtitle and back link", () => {
    openDescribe();

    expect(
      screen.getByRole("heading", { name: /create an agentic swarm/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/set up your environment and then describe your users/i),
    ).toBeVisible();

    fireEvent.click(screen.getByTestId("new-swarm-back-to-swarms"));
    expect(navigateMock).toHaveBeenCalledWith("/swarms");
  });

  it("prefills the Swarm name and blocks Continue when it is cleared", () => {
    openDescribe();

    const name = screen.getByTestId("new-swarm-name") as HTMLInputElement;
    expect(name.value.length).toBeGreaterThan(0);

    fireEvent.change(screen.getByTestId("new-swarm-describe-input"), {
      target: { value: "Support agents answering refunds" },
    });
    expect(screen.getByTestId("new-swarm-continue")).not.toBeDisabled();

    // Required, and it says so instead of just going dead.
    fireEvent.change(name, { target: { value: "   " } });
    expect(screen.getByTestId("new-swarm-continue")).toBeDisabled();
    expect(screen.getByTestId("new-swarm-continue-hint")).toHaveTextContent(
      /name this swarm to continue/i,
    );

    fireEvent.change(name, { target: { value: "Billing swarm" } });
    expect(screen.getByTestId("new-swarm-continue")).not.toBeDisabled();
  });

  it("names the swarm from the field, not from the description paragraph", async () => {
    openDescribe();
    fireEvent.change(screen.getByTestId("new-swarm-name"), {
      target: { value: "Billing swarm" },
    });
    fireEvent.change(screen.getByTestId("new-swarm-describe-input"), {
      target: { value: "Support agents answering refunds" },
    });
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");
    fireEvent.click(screen.getByTestId("new-swarm-launch"));

    await vi.waitFor(() => {
      expect(createSwarmMock).toHaveBeenCalled();
    });
    expect(createSwarmMock.mock.calls[0][0]).toMatchObject({
      name: "Billing swarm",
      description: "Support agents answering refunds",
    });
  });

  it("labels the scope options with the sessions each one costs", () => {
    openDescribe();

    const scope = screen.getByTestId("new-swarm-push-intensity");
    expect(scope).toHaveTextContent("Quick look");
    expect(scope).toHaveTextContent("15 sessions");
    expect(scope).toHaveTextContent("Standard");
    expect(scope).toHaveTextContent("36 sessions");
    expect(scope).toHaveTextContent("Launch gate");
    expect(scope).toHaveTextContent("120 sessions");
  });

  it("lists attached personas as removable rows, not as a checklist", () => {
    existingPersonas = [
      { _id: "p-1", personaId: "p1", name: "Ana", role: "Ops", notes: "" },
    ];
    openDescribe();

    // Nothing attached yet: the rows only exist once a persona is picked.
    expect(
      screen.queryByTestId("new-swarm-attached-personas"),
    ).not.toBeInTheDocument();

    pickExistingPersona(/include ana/i);
    const attached = screen.getByTestId("new-swarm-attached-personas");
    expect(attached).toHaveTextContent("Ana");
    expect(attached).toHaveTextContent("Ops");

    fireEvent.click(screen.getByRole("button", { name: /remove ana/i }));
    expect(
      screen.queryByTestId("new-swarm-attached-personas"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("new-swarm-continue")).toBeDisabled();
  });

  it("hides the persona picker entirely when the project has none", () => {
    existingPersonas = [];
    openDescribe();

    expect(
      screen.queryByTestId("new-swarm-add-existing-personas"),
    ).not.toBeInTheDocument();
  });
});

// BB-122: Confirm personas. These cover what the redesign added — the shared
// header, the Edit affordance, adding existing personas from this step, and the
// renamed primary — plus the promise the task is built on: every field editable
// without leaving the page.
describe("SwarmsTab — Confirm personas (Production Redesign)", () => {
  async function reachConfirm() {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");
  }

  it("carries the same header, with Describe done and Confirm current", async () => {
    await reachConfirm();

    const stepper = screen.getByTestId("new-swarm-progress");
    const current = within(stepper)
      .getAllByRole("listitem")
      .filter((item) => item.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Confirm personas");

    // Describe is complete, so it is the one step offered as a way back.
    expect(
      within(stepper)
        .getAllByRole("button")
        .map((node) => node.getAttribute("aria-label")),
    ).toEqual(["Back to Describe"]);

    // The old chrome bar is Running's alone now.
    expect(screen.getByTestId("new-swarm-back-to-swarms")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^cancel$/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the redesigned title and leads the helper with the session spend", async () => {
    await reachConfirm();

    expect(
      screen.getByRole("heading", {
        name: /review user personas and what they.{0,3}ll accomplish/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/run \d+ sessions? total in this swarm/i),
    ).toBeVisible();
  });

  it("puts Edit and Remove on the card, not behind an overflow menu", async () => {
    await reachConfirm();

    const card = screen.getAllByTestId("new-swarm-persona-compact")[0];
    // Both are real, visible buttons — the whole point of the step is that the
    // slate is editable, and a hover-only affordance does not say so.
    const edit = within(card).getByRole("button", { name: /^edit persona /i });
    expect(edit).toBeVisible();
    expect(
      within(card).getByRole("button", { name: /^remove persona /i }),
    ).toBeVisible();

    fireEvent.click(edit);
    expect(
      await screen.findByTestId("new-swarm-persona-detail"),
    ).toBeInTheDocument();
  });

  it("does not announce the card itself as a button around two more", async () => {
    // A widget containing widgets is the one nesting assistive tech cannot
    // describe: the row used to announce itself as a single button whose
    // contents were Edit and Remove. Pointer users keep the whole-card click.
    await reachConfirm();

    const card = screen.getAllByTestId("new-swarm-persona-compact")[0];
    expect(card).not.toHaveAttribute("role", "button");
    expect(card).not.toHaveAttribute("tabindex");

    fireEvent.click(card);
    expect(
      await screen.findByTestId("new-swarm-persona-detail"),
    ).toBeInTheDocument();
  });

  it("edits every field of a proposed persona in place, then closes on Save", async () => {
    await reachConfirm();
    fireEvent.click(screen.getAllByTestId("new-swarm-persona-compact")[0]);
    const detail = await screen.findByTestId("new-swarm-persona-detail");

    fireEvent.change(within(detail).getByLabelText("Persona name"), {
      target: { value: "Renamed persona" },
    });
    fireEvent.change(within(detail).getByLabelText("Persona role"), {
      target: { value: "Renamed role" },
    });
    fireEvent.change(within(detail).getByLabelText("Use cases and context"), {
      target: { value: "Fresh context" },
    });

    expect(
      within(detail).getByDisplayValue("Renamed persona"),
    ).toBeInTheDocument();
    expect(
      within(detail).getByDisplayValue("Renamed role"),
    ).toBeInTheDocument();
    expect(
      within(detail).getByDisplayValue("Fresh context"),
    ).toBeInTheDocument();

    // In-memory edits already landed, so Save is only "done here" — and it is
    // live regardless, because a dead button is not a way out of the editor.
    const save = within(detail).getByTestId("new-swarm-persona-save");
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await vi.waitFor(() => {
      expect(
        screen.queryByTestId("new-swarm-persona-detail"),
      ).not.toBeInTheDocument();
    });
    // The edit survived the collapse.
    expect(screen.getByTestId("new-swarm-proposed-personas")).toHaveTextContent(
      "Renamed persona",
    );
  });

  it("adds an existing persona from this step, and stops offering it once added", async () => {
    existingPersonas = [
      { _id: "p-9", personaId: "p9", name: "Zoe", role: "Support", notes: "" },
    ];
    await reachConfirm();

    fireEvent.click(screen.getByTestId("new-swarm-confirm-add-existing"));
    fireEvent.click(screen.getByRole("button", { name: /^add zoe$/i }));

    const reused = await screen.findByTestId("new-swarm-reused-personas");
    expect(reused).toHaveTextContent("Zoe");
    // Nothing left to offer, so the affordance goes rather than opening empty.
    expect(
      screen.queryByTestId("new-swarm-confirm-add-existing"),
    ).not.toBeInTheDocument();
  });

  it("names the primary Launch Swarm, with Back beside it", async () => {
    await reachConfirm();

    expect(screen.getByTestId("new-swarm-launch")).toHaveTextContent(
      "Launch Swarm",
    );
    expect(screen.getByRole("button", { name: /^back$/i })).toBeVisible();
  });
});

describe("SwarmsTab — expanded persona card is the editor, not the list row", () => {
  async function expandFirstPersona() {
    openDescribe();
    fillDescribe();
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-proposed-personas");
    fireEvent.click(screen.getAllByTestId("new-swarm-persona-compact")[0]);
    return screen.findByTestId("new-swarm-persona-detail");
  }

  it("carries no Remove and no close control — those belong to the collapsed card", async () => {
    const detail = await expandFirstPersona();

    expect(
      within(detail).queryByRole("button", { name: /^remove persona /i }),
    ).not.toBeInTheDocument();
    expect(
      within(detail).queryByRole("button", { name: /close persona detail/i }),
    ).not.toBeInTheDocument();
    // Save changes is the one control the header carries.
    expect(within(detail).getByTestId("new-swarm-persona-save")).toBeVisible();

    // Remove is still one click away, on the sibling row.
    expect(
      within(screen.getAllByTestId("new-swarm-persona-compact")[0]).getByRole(
        "button",
        { name: /^remove persona /i },
      ),
    ).toBeVisible();
  });

  it("takes focus on open, so Escape has somewhere to fire from", async () => {
    // The Edit button that opens the panel unmounts on the same commit, so
    // without this focus falls to <body> and the keydown handler never sees
    // Escape. Firing keyDown at the panel element directly — which the first
    // version of this test did — passes either way and proves nothing.
    const detail = await expandFirstPersona();

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(detail);
    });

    // Dispatched from wherever focus actually is, the way a user reaches it.
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await vi.waitFor(() => {
      expect(
        screen.queryByTestId("new-swarm-persona-detail"),
      ).not.toBeInTheDocument();
    });
  });

  it("bubbles Escape out of a field the user is typing in", async () => {
    // Focus starts on the container but moves as soon as anyone edits, so the
    // handler has to catch the event on its way up too.
    const detail = await expandFirstPersona();
    const name = within(detail).getByLabelText("Persona name");
    name.focus();

    fireEvent.keyDown(name, { key: "Escape" });

    await vi.waitFor(() => {
      expect(
        screen.queryByTestId("new-swarm-persona-detail"),
      ).not.toBeInTheDocument();
    });
  });
});

describe("SwarmsTab — a reused persona whose save fails", () => {
  const ANA = {
    _id: "p-1",
    personaId: "p1",
    name: "Ana",
    role: "Ops",
    notes: "Closes the books monthly.",
  };
  const JOURNEY = {
    _id: "j-existing",
    name: "Reconcile payouts",
    goal: "Reconcile",
    hostIds: ["host-1"],
    environmentIds: ["env-1"],
    config: { sessionsPerTarget: 1, maxTurns: 6 },
  };

  async function openReusedPersona() {
    existingPersonas = [ANA];
    personaJourneys = [JOURNEY];
    openDescribe();
    pickExistingPersona(/include ana/i);
    fireEvent.click(screen.getByTestId("new-swarm-continue"));
    await screen.findByTestId("new-swarm-reused-personas");
    fireEvent.click(screen.getByTestId("new-swarm-persona-compact"));
    return screen.findByTestId("new-swarm-persona-detail");
  }

  // `saveReused` is invoked with `void`, so before this had a catch a rejected
  // write was an unhandled promise: no toast, no console, nothing on screen.
  it("reports a failed persona write and keeps the draft on screen", async () => {
    updatePersonaMock.mockRejectedValue(new Error("persona rejected"));
    const detail = await openReusedPersona();

    fireEvent.change(within(detail).getByLabelText("Persona role"), {
      target: { value: "Finance ops" },
    });
    fireEvent.click(within(detail).getByTestId("new-swarm-persona-save"));

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("persona rejected"),
      );
    });
    // ONCE. `savePersonaField` also toasts and rethrows, so routing Confirm's
    // save through it showed the same error twice; the flow gets the raw
    // mutation instead.
    expect(toast.error).toHaveBeenCalledTimes(1);
    // Still open, still holding the edit, so it can be retried.
    expect(screen.getByTestId("new-swarm-persona-detail")).toBeInTheDocument();
    expect(within(detail).getByLabelText("Persona role")).toHaveValue(
      "Finance ops",
    );
  });

  it("reports a failed goal write and keeps the draft on screen", async () => {
    updateJourneyMock.mockRejectedValue(new Error("goal rejected"));
    const detail = await openReusedPersona();

    fireEvent.change(within(detail).getByDisplayValue("Reconcile payouts"), {
      target: { value: "Reconcile payouts weekly" },
    });
    fireEvent.click(within(detail).getByTestId("new-swarm-persona-save"));

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("goal rejected"),
      );
    });
    expect(screen.getByTestId("new-swarm-persona-detail")).toBeInTheDocument();
    expect(
      within(detail).getByDisplayValue("Reconcile payouts weekly"),
    ).toBeInTheDocument();
  });

  /**
   * Escape is a CANCEL for a reused persona, not just a collapse.
   *
   * Keeping the draft instead would leave an edit that the collapsed card
   * doesn't show and the launch doesn't use: the swarm runs with the stored
   * values and the user only learns their typing did nothing afterwards.
   */
  it("discards a reused persona's unsaved edits on Escape, and says so", async () => {
    const detail = await openReusedPersona();

    fireEvent.change(within(detail).getByLabelText("Persona role"), {
      target: { value: "Finance ops" },
    });
    fireEvent.keyDown(within(detail).getByLabelText("Persona role"), {
      key: "Escape",
    });

    await vi.waitFor(() => {
      expect(
        screen.queryByTestId("new-swarm-persona-detail"),
      ).not.toBeInTheDocument();
    });
    // Nothing reached the shared row.
    expect(updatePersonaMock).not.toHaveBeenCalled();
    // Silently dropping typed text is the other half of the same problem.
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining("Discarded unsaved changes to Ana"),
    );

    // Reopening shows the stored persona, not the abandoned draft.
    fireEvent.click(screen.getByTestId("new-swarm-persona-compact"));
    const reopened = await screen.findByTestId("new-swarm-persona-detail");
    expect(within(reopened).getByLabelText("Persona role")).toHaveValue("Ops");
  });

  it("says nothing when Escape closes a panel nobody edited", async () => {
    const detail = await openReusedPersona();

    fireEvent.keyDown(detail, { key: "Escape" });

    await vi.waitFor(() => {
      expect(
        screen.queryByTestId("new-swarm-persona-detail"),
      ).not.toBeInTheDocument();
    });
    // A discard notice for a discard that didn't happen is just noise.
    expect(toast.info).not.toHaveBeenCalled();
    expect(updatePersonaMock).not.toHaveBeenCalled();
  });
});
