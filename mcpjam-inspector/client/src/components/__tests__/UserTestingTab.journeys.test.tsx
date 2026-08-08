/**
 * The `:scenarioId` resolution ladder, and the standalone-host must-fix.
 *
 * `:scenarioId` is a CHATBOX id. This suite pins the three things that ladder
 * owes its callers: links minted under the old host-id scheme still land on
 * the right scenario, an id that resolves to nothing says so without ever
 * reaching the wire (`getChatbox` declares `v.id('chatboxes')` — an unknown id
 * THROWS out of useQuery and takes the screen with it), and a Journeys-owned
 * host — which has no share surface and therefore no chatbox at all — gets the
 * "Managed by Swarms" dead-end instead of a bare not-found.
 *
 * The surface no longer provisions anything on mount: a host without a chatbox
 * simply has no scenario. `ensureMock` is asserted-never here to keep it that
 * way.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@/hooks/useClients";
import type { ChatboxListItem } from "@/hooks/useChatboxes";

const {
  ensureMock,
  navigateMock,
  hostListState,
  listState,
  chatboxState,
  chatboxQuerySpy,
} = vi.hoisted(() => ({
  ensureMock: vi.fn().mockResolvedValue(undefined),
  navigateMock: vi.fn(),
  hostListState: { hosts: [] as HostListItem[], isLoading: false },
  listState: {
    chatboxes: [] as ChatboxListItem[] | undefined,
    isLoading: false,
  },
  chatboxState: { chatbox: null as unknown, isLoading: false },
  // A spy, not a plain factory: one case asserts on the ARGS the surface hands
  // the chatbox query.
  chatboxQuerySpy:
    vi.fn<
      (args: { isAuthenticated: boolean; chatboxId: string | null }) => void
    >(),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: (name: string) =>
    name === "chatboxes:ensureChatboxForHost" ? ensureMock : vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => hostListState,
  // The tab holds `createHost` for the create route; these suites never reach
  // it, but an absent export fails module resolution.
  useHostMutations: () => ({ createHost: vi.fn() }),
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatbox: (args: {
    isAuthenticated: boolean;
    chatboxId: string | null;
  }) => {
    chatboxQuerySpy(args);
    return chatboxState;
  },
  useChatboxList: () => listState,
  useChatboxMutations: () => ({ deleteChatbox: vi.fn() }),
  useEnvironmentChatboxMutations: () => ({
    publishEnvironmentChatbox: vi.fn(),
  }),
}));

// The surface reads environments for the agent's publish tool and its
// snapshot; these suites don't exercise either.
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

vi.mock("@/hooks/useUsageInsights", () => ({
  useUsageInsights: () => ({
    threads: undefined,
    breakdown: undefined,
    rebuild: vi.fn(),
  }),
}));

vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Stub the heavy children so we don't pull their whole dependency trees; none
// of the states under test render them anyway.
vi.mock("@/components/chatboxes/UserTestingScenarioDetail", () => ({
  UserTestingScenarioDetail: () => <div data-testid="scenario-detail" />,
}));
vi.mock("@/components/chatboxes/UserTestingOverviewPanel", () => ({
  UserTestingOverviewPanel: () => <div data-testid="scenario-overview" />,
}));

import { UserTestingTab } from "../UserTestingTab";

const SCENARIO_HOST_ID = "host-journeys";

function hostFixture(overrides: Partial<HostListItem>): HostListItem {
  return {
    hostId: SCENARIO_HOST_ID,
    name: "Swarm Client",
    hostConfigId: "cfg-1",
    modelId: "anthropic/claude-haiku-4.5",
    serverCount: 0,
    ownerScope: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function rowFixture(overrides: Partial<ChatboxListItem>): ChatboxListItem {
  return {
    chatboxId: "cb-1",
    projectId: "proj-1",
    name: "Payments beta",
    hostStyle: "cursor",
    mode: "anyone_with_link",
    allowGuestAccess: true,
    serverCount: 0,
    serverNames: [],
    namedHostId: "host-real",
    namedHostName: "Cursor",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function renderScenario(scenarioId: string = SCENARIO_HOST_ID) {
  return render(
    <UserTestingTab
      projectId="proj-1"
      isAuthenticated
      scenarioId={scenarioId}
    />,
  );
}

describe("UserTestingTab — scenario resolution", () => {
  afterEach(() => {
    ensureMock.mockClear();
    navigateMock.mockClear();
    chatboxQuerySpy.mockClear();
    hostListState.hosts = [];
    hostListState.isLoading = false;
    listState.chatboxes = [];
    listState.isLoading = false;
    chatboxState.chatbox = null;
    chatboxState.isLoading = false;
  });

  it("shows the Swarms dead-end for a Journeys-owned host, and never provisions", async () => {
    // A standalone host has no publish surface, so nothing in the scenario
    // list points at it. Without this branch it would read as "not found",
    // which hides the reason and the way out.
    hostListState.hosts = [hostFixture({ ownerScope: { type: "journeys" } })];
    listState.chatboxes = [];

    renderScenario();

    expect(await screen.findByText(/Managed by Swarms/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Go to Swarms/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(ensureMock).not.toHaveBeenCalled();
    });
  });

  it("redirects a legacy host-id link onto its chatbox id", async () => {
    // Every link copied before the identity change carries a host id.
    listState.chatboxes = [
      rowFixture({ chatboxId: "cb-42", namedHostId: "host-real" }),
    ];

    renderScenario("host-real");

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/user-testing/cb-42", {
        replace: true,
      });
    });
    // Not a 404 while the redirect is in flight.
    expect(screen.queryByText(/Scenario not found/i)).not.toBeInTheDocument();
  });

  it("an environment-backed row never absorbs the host's legacy links", async () => {
    // Environment-backed rows carry a `namedHostId` for DISPLAY only, and
    // several can point at the same host. Matching on it would hand an old
    // link to an unrelated scenario — the same rule the backend's
    // `getHostPublishChatbox` enforces.
    listState.chatboxes = [
      rowFixture({
        chatboxId: "cb-env",
        namedHostId: "host-real",
        environmentId: "env-1",
      }),
    ];

    renderScenario("host-real");

    expect(await screen.findByText(/Scenario not found/i)).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("waits for the list before deciding anything", async () => {
    listState.chatboxes = undefined;
    listState.isLoading = true;

    renderScenario();

    await waitFor(() => {
      expect(screen.queryByText(/Scenario not found/i)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/Managed by Swarms/i)).not.toBeInTheDocument();
  });

  it("a host with no scenario is not-found — nothing is minted on the way in", async () => {
    // This used to back-mint a chatbox on mount. A scenario is now something
    // that already exists; a client without one simply isn't one.
    hostListState.hosts = [hostFixture({ ownerScope: null })];
    listState.chatboxes = [];

    renderScenario();

    expect(await screen.findByText(/Scenario not found/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Back to User Testing/i }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(ensureMock).not.toHaveBeenCalled();
    });
  });

  it("never puts an unknown :scenarioId on the wire", async () => {
    // `getChatbox` declares `v.id('chatboxes')`, so a hand-typed or stale id
    // does not come back null — it THROWS out of useQuery and takes the screen
    // with it. Validating against the loaded list first is what keeps a bad
    // URL from white-screening the app.
    hostListState.hosts = [hostFixture({ hostId: "host-real" })];
    listState.chatboxes = [rowFixture({ chatboxId: "cb-1" })];

    renderScenario("not-a-real-id");

    expect(await screen.findByText(/Scenario not found/i)).toBeInTheDocument();
    expect(chatboxQuerySpy).toHaveBeenCalled();
    for (const [args] of chatboxQuerySpy.mock.calls) {
      expect(args.chatboxId).toBeNull();
    }
  });
});
