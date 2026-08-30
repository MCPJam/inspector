/**
 * What the scenario list is allowed to show.
 *
 * The reported bug: a brand-new project showed four or five "scenarios" nobody
 * created — the three clients the Playground seeds into an empty project, the
 * "MCPJam" one the host bar seeds, and one per client set up in Servers. They
 * were there because a scenario row is minted 1:1 with every host, and the list
 * rendered every row.
 *
 * The filter runs only where environments exist (the flag), because a project
 * without them has no other kind of scenario to show. Direct links keep
 * working either way — that is asserted here too, since filtering the list is
 * an editorial choice about what to advertise, not about what exists.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenarioListItem } from "@/hooks/useScenarios";

const { navigateMock, listState, scenarioState, flagState } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  listState: {
    scenarios: [] as ScenarioListItem[] | undefined,
    isLoading: false,
  },
  scenarioState: { scenario: null as unknown, isLoading: false },
  flagState: { enabled: true },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: () => vi.fn(),
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

// `useAppNavigate`, not react-router's `useNavigate`: app navigation goes
// through the scoped helper now, which carries the active project into
// project-owned paths (`/p/<projectId>/hosts/<id>`). The rest of
// `app-navigation` is the real module — these suites assert against its
// path builders.
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => navigateMock,
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: [], isLoading: false }),
  useHostMutations: () => ({ createHost: vi.fn() }),
}));

vi.mock("@/hooks/useScenarios", () => ({
  useScenario: () => scenarioState,
  useScenarioList: () => listState,
  useScenarioMutations: () => ({ deleteScenario: vi.fn() }),
  useEnvironmentScenarioMutations: () => ({
    publishEnvironmentScenario: vi.fn(),
  }),
}));

// The surface reads environments for the agent's publish tool and its
// snapshot; these suites don't exercise either.
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => flagState.enabled,
}));

vi.mock("@/hooks/useUsageInsights", () => ({
  useUsageInsights: () => ({
    threads: undefined,
    breakdown: undefined,
    rebuild: vi.fn(),
  }),
}));

vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The overview panel reads the theme to pick client logos; the store has no
// provider in a bare render.
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

vi.mock("@/components/scenarios/UserTestingScenarioDetail", () => ({
  UserTestingScenarioDetail: () => <div data-testid="scenario-detail" />,
}));

import { UserTestingTab } from "../UserTestingTab";

const row = (over: Partial<ScenarioListItem>): ScenarioListItem => ({
  scenarioId: "cb-seed",
  projectId: "proj-1",
  name: "Claude Code",
  hostStyle: "claude",
  // The backend default every auto-mint path uses.
  mode: "project_members",
  allowGuestAccess: false,
  serverCount: 0,
  serverNames: [],
  namedHostId: "host-seed",
  namedHostName: "Claude Code",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

/** The exact lineup a fresh project reported: seeds + one real scenario. */
const SEEDED_PROJECT: ScenarioListItem[] = [
  row({ scenarioId: "cb-seed-1", name: "Claude Code", namedHostId: "h1" }),
  row({ scenarioId: "cb-seed-2", name: "ChatGPT", namedHostId: "h2" }),
  row({ scenarioId: "cb-seed-3", name: "MCPJam", namedHostId: "h3" }),
  row({
    scenarioId: "cb-real",
    name: "Checkout flow",
    namedHostId: "h4",
    environmentId: "env-1",
    environmentName: "Checkout flow",
  }),
];

afterEach(() => {
  navigateMock.mockClear();
  listState.scenarios = [];
  listState.isLoading = false;
  scenarioState.scenario = null;
  flagState.enabled = true;
});

describe("UserTestingTab — which scenarios the list advertises", () => {
  it("hides auto-minted client rows and keeps the published environment", async () => {
    listState.scenarios = SEEDED_PROJECT;

    render(<UserTestingTab projectId="proj-1" isAuthenticated />);

    const rows = await screen.findAllByTestId("user-testing-overview-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-scenario-id", "cb-real");
    expect(screen.queryByText("ChatGPT")).not.toBeInTheDocument();
  });

  it("shows the empty state for a project that only has seeded clients", async () => {
    listState.scenarios = SEEDED_PROJECT.filter((r) => !r.environmentId);

    render(<UserTestingTab projectId="proj-1" isAuthenticated />);

    // "You haven't made one yet" is the truth here; four phantom rows were not.
    expect(
      await screen.findByTestId("user-testing-overview-empty"),
    ).toBeInTheDocument();
  });

  it("keeps a legacy client row that real testers actually used", async () => {
    listState.scenarios = [
      row({ scenarioId: "cb-used", name: "Cursor", uniqueTesterCount: 3 }),
      row({ scenarioId: "cb-idle", name: "Copilot" }),
    ];

    render(<UserTestingTab projectId="proj-1" isAuthenticated />);

    const rows = await screen.findAllByTestId("user-testing-overview-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-scenario-id", "cb-used");
  });

  it("still opens a filtered-out row by direct link", async () => {
    // Hiding a row from the list says "not worth advertising", never "gone".
    listState.scenarios = SEEDED_PROJECT;
    scenarioState.scenario = { scenarioId: "cb-seed-1", name: "Claude Code" };

    render(
      <UserTestingTab
        projectId="proj-1"
        isAuthenticated
        scenarioId="cb-seed-1"
      />,
    );

    expect(await screen.findByTestId("scenario-detail")).toBeInTheDocument();
    expect(screen.queryByText(/Scenario not found/i)).not.toBeInTheDocument();
  });

  it("does not filter when environments are off", async () => {
    // Such a project has no environment-backed scenarios, so filtering would
    // leave it with a surface it cannot use.
    flagState.enabled = false;
    listState.scenarios = SEEDED_PROJECT;

    render(<UserTestingTab projectId="proj-1" isAuthenticated />);

    await waitFor(async () => {
      expect(
        await screen.findAllByTestId("user-testing-overview-row"),
      ).toHaveLength(4);
    });
  });
});
