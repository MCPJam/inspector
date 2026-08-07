/**
 * Guards the standalone-host must-fix and the `:scenarioId` validation gate.
 *
 * A Journeys-owned host has NO share surface, so the User Testing surface must
 * (a) never back-mint a chatbox for it and (b) render the "Managed by Swarms"
 * notice with a way out. The surrounding cases pin the decision inputs: it
 * back-mints for an untagged chatbox-less host, waits for the host list before
 * deciding anything, and treats a host that isn't in the list as not-found —
 * without ever putting that id on the wire.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@/hooks/useClients";

const {
  ensureMock,
  navigateMock,
  hostListState,
  chatboxState,
  chatboxQuerySpy,
} = vi.hoisted(() => ({
  ensureMock: vi.fn().mockResolvedValue(undefined),
  navigateMock: vi.fn(),
  hostListState: { hosts: [] as HostListItem[], isLoading: false },
  chatboxState: { chatbox: null as unknown, isLoading: false },
  // A spy, not a plain factory: one case asserts on the ARGS the surface hands
  // the chatbox query.
  chatboxQuerySpy:
    vi.fn<
      (args: { isAuthenticated: boolean; hostId: string | null }) => void
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
  useChatboxByHostId: (args: {
    isAuthenticated: boolean;
    hostId: string | null;
  }) => {
    chatboxQuerySpy(args);
    return chatboxState;
  },
  useChatboxList: () => ({ chatboxes: [], isLoading: false }),
  useChatboxMutations: () => ({ deleteChatbox: vi.fn() }),
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

function renderScenario(scenarioHostId: string = SCENARIO_HOST_ID) {
  return render(
    <UserTestingTab
      projectId="proj-1"
      isAuthenticated
      scenarioHostId={scenarioHostId}
    />
  );
}

describe("UserTestingTab — Journeys-owned (standalone) host", () => {
  afterEach(() => {
    ensureMock.mockClear();
    navigateMock.mockClear();
    chatboxQuerySpy.mockClear();
    hostListState.hosts = [];
    hostListState.isLoading = false;
    chatboxState.chatbox = null;
    chatboxState.isLoading = false;
  });

  it("does NOT back-mint a chatbox and shows the notice + a way to Swarms", async () => {
    hostListState.hosts = [hostFixture({ ownerScope: { type: "journeys" } })];
    chatboxState.chatbox = null; // journeys host has no chatbox

    renderScenario();

    expect(await screen.findByText(/Managed by Swarms/i)).toBeInTheDocument();
    // Recoverable: the notice offers the surface that actually owns this host.
    expect(
      screen.getByRole("button", { name: /Go to Swarms/i })
    ).toBeInTheDocument();
    // Critically: the auto-ensure mutation is never fired for a journeys host.
    await waitFor(() => {
      expect(ensureMock).not.toHaveBeenCalled();
    });
  });

  it("DOES back-mint for a chatbox-less untagged host (control)", async () => {
    hostListState.hosts = [
      hostFixture({ name: "Legacy Client", ownerScope: null }),
    ];
    chatboxState.chatbox = null;

    renderScenario();

    await waitFor(() => {
      expect(ensureMock).toHaveBeenCalledWith({ hostId: SCENARIO_HOST_ID });
    });
    expect(screen.queryByText(/Managed by Swarms/i)).not.toBeInTheDocument();
  });

  it("waits for the host list to load before deciding (no ensure while loading)", async () => {
    // The host list carries ownerScope; deciding before it lands would race a
    // chatbox onto a standalone host.
    hostListState.hosts = [];
    hostListState.isLoading = true;
    chatboxState.chatbox = null;

    renderScenario();

    await waitFor(() => {
      expect(ensureMock).not.toHaveBeenCalled();
    });
    expect(screen.queryByText(/Managed by Swarms/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Scenario not found/i)).not.toBeInTheDocument();
  });

  it("a RESOLVED-missing host renders not-found and never provisions", async () => {
    // The list finished and this host is gone (deleted / not visible) —
    // provisioning would just fail the mutation and strand the spinner.
    hostListState.hosts = [];
    hostListState.isLoading = false;
    chatboxState.chatbox = null;

    renderScenario();

    expect(await screen.findByText(/Scenario not found/i)).toBeInTheDocument();
    // Recoverable: a way back to the scenario list rather than a dead end.
    expect(
      screen.getByRole("button", { name: /Back to User Testing/i })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(ensureMock).not.toHaveBeenCalled();
    });
  });

  it("never puts an unknown :scenarioId on the wire", async () => {
    // `getChatboxByHostId` declares `v.id("hosts")`, so a hand-typed or stale
    // id does not come back null — it THROWS out of useQuery and takes the
    // screen with it. Validating against the loaded host list first is what
    // keeps a bad URL from white-screening the app.
    hostListState.hosts = [hostFixture({ hostId: "host-real" })];
    hostListState.isLoading = false;

    renderScenario("not-a-real-host-id");

    expect(await screen.findByText(/Scenario not found/i)).toBeInTheDocument();
    expect(ensureMock).not.toHaveBeenCalled();
    expect(chatboxQuerySpy).toHaveBeenCalled();
    for (const [args] of chatboxQuerySpy.mock.calls) {
      expect(args.hostId).toBeNull();
    }
  });
});
