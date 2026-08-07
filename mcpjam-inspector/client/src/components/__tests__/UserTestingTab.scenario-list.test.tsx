/**
 * What the scenario list is allowed to show.
 *
 * The reported bug: a brand-new project showed four or five "scenarios" nobody
 * created — the three clients the Playground seeds into an empty project, the
 * "MCPJam" one the host bar seeds, and one per client set up in Servers. They
 * were there because a chatbox row is minted 1:1 with every host, and the list
 * rendered every row.
 *
 * The filter runs only where environments exist (the flag), because a project
 * without them has no other kind of scenario to show. Direct links keep
 * working either way — that is asserted here too, since filtering the list is
 * an editorial choice about what to advertise, not about what exists.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatboxListItem } from "@/hooks/useChatboxes";

const { navigateMock, listState, chatboxState, flagState } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  listState: {
    chatboxes: [] as ChatboxListItem[] | undefined,
    isLoading: false,
  },
  chatboxState: { chatbox: null as unknown, isLoading: false },
  flagState: { enabled: true },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: () => vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: [], isLoading: false }),
  useHostMutations: () => ({ createHost: vi.fn() }),
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatbox: () => chatboxState,
  useChatboxList: () => listState,
  useChatboxMutations: () => ({ deleteChatbox: vi.fn() }),
  useEnvironmentChatboxMutations: () => ({
    publishEnvironmentChatbox: vi.fn(),
  }),
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

vi.mock("@/components/chatboxes/UserTestingScenarioDetail", () => ({
  UserTestingScenarioDetail: () => <div data-testid="scenario-detail" />,
}));

import { UserTestingTab } from "../UserTestingTab";

const row = (over: Partial<ChatboxListItem>): ChatboxListItem => ({
  chatboxId: "cb-seed",
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
const SEEDED_PROJECT: ChatboxListItem[] = [
  row({ chatboxId: "cb-seed-1", name: "Claude Code", namedHostId: "h1" }),
  row({ chatboxId: "cb-seed-2", name: "ChatGPT", namedHostId: "h2" }),
  row({ chatboxId: "cb-seed-3", name: "MCPJam", namedHostId: "h3" }),
  row({
    chatboxId: "cb-real",
    name: "Checkout flow",
    namedHostId: "h4",
    environmentId: "env-1",
    environmentName: "Checkout flow",
  }),
];

afterEach(() => {
  navigateMock.mockClear();
  listState.chatboxes = [];
  listState.isLoading = false;
  chatboxState.chatbox = null;
  flagState.enabled = true;
});

describe("UserTestingTab — which scenarios the list advertises", () => {
  it("hides auto-minted client rows and keeps the published environment", async () => {
    listState.chatboxes = SEEDED_PROJECT;

    render(<UserTestingTab projectId="proj-1" isAuthenticated />);

    const rows = await screen.findAllByTestId("user-testing-overview-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-scenario-id", "cb-real");
    expect(screen.queryByText("ChatGPT")).not.toBeInTheDocument();
  });

  it("shows the empty state for a project that only has seeded clients", async () => {
    listState.chatboxes = SEEDED_PROJECT.filter((r) => !r.environmentId);

    render(<UserTestingTab projectId="proj-1" isAuthenticated />);

    // "You haven't made one yet" is the truth here; four phantom rows were not.
    expect(
      await screen.findByTestId("user-testing-overview-empty"),
    ).toBeInTheDocument();
  });

  it("keeps a legacy client row that real testers actually used", async () => {
    listState.chatboxes = [
      row({ chatboxId: "cb-used", name: "Cursor", uniqueTesterCount: 3 }),
      row({ chatboxId: "cb-idle", name: "Copilot" }),
    ];

    render(<UserTestingTab projectId="proj-1" isAuthenticated />);

    const rows = await screen.findAllByTestId("user-testing-overview-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-scenario-id", "cb-used");
  });

  it("still opens a filtered-out row by direct link", async () => {
    // Hiding a row from the list says "not worth advertising", never "gone".
    listState.chatboxes = SEEDED_PROJECT;
    chatboxState.chatbox = { chatboxId: "cb-seed-1", name: "Claude Code" };

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
    listState.chatboxes = SEEDED_PROJECT;

    render(<UserTestingTab projectId="proj-1" isAuthenticated />);

    await waitFor(async () => {
      expect(
        await screen.findAllByTestId("user-testing-overview-row"),
      ).toHaveLength(4);
    });
  });
});
