/**
 * UserTestingTab agent bridge handlers. Commands are dispatched through the
 * real command bus against a mounted UserTestingTab; the ensure/delete
 * mutations, the host list and the chatbox list are mocked so the handlers act
 * through the SAME callbacks the buttons/dialogs use.
 *
 * Findings this pins:
 * - publish resolves a host, provisions its scenario, and OPENS the scenario
 *   route (the surface has no in-page selection any more — the URL is the
 *   view state, so "select it" means navigate);
 * - publish HONORS the Swarms-owned dead-end (unsupported_in_mode, no ensure);
 * - host resolution is EXACT: unknown and ambiguous both fail invalid_request
 *   without touching a mutation;
 * - delete maps to deleteChatbox, and a deleted scenario STAYS deleted;
 * - every command is refused when signed out;
 * - the snapshot reports redacted state and NEVER the share token / transcript
 *   text / visitor PII.
 */
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";
import type { ChatboxListItem, ChatboxSettings } from "@/hooks/useChatboxes";
import type { HostListItem } from "@/hooks/useClients";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import type {
  InspectorCommand,
  InspectorCommandError,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";

const SHARE_TOKEN = "SECRET-SHARE-TOKEN-do-not-leak";
const TRANSCRIPT = "TRANSCRIPT-CONTENTS-do-not-leak";
const VISITOR_PII = "Jane Visitor <jane@example.com>";

const hostClaude: HostListItem = {
  hostId: "host-1",
  name: "Claude",
  hostConfigId: "cfg-1",
  modelId: "anthropic/claude-haiku-4.5",
  serverCount: 1,
  ownerScope: null,
  createdAt: 0,
  updatedAt: 0,
};
const hostCursor: HostListItem = {
  hostId: "host-2",
  name: "Cursor",
  hostConfigId: "cfg-2",
  modelId: "anthropic/claude-sonnet-4.5",
  serverCount: 0,
  ownerScope: null,
  createdAt: 0,
  updatedAt: 0,
};
const hostJourney: HostListItem = {
  hostId: "host-3",
  name: "Journey bot",
  hostConfigId: "cfg-3",
  modelId: "anthropic/claude-haiku-4.5",
  serverCount: 0,
  ownerScope: { type: "journeys" },
  createdAt: 0,
  updatedAt: 0,
};
/** Same NAME as hostCursor — only the ambiguity case puts it in the list. */
const hostCursorTwin: HostListItem = {
  hostId: "host-4",
  name: "Cursor",
  hostConfigId: "cfg-4",
  modelId: "anthropic/claude-sonnet-4.5",
  serverCount: 0,
  ownerScope: null,
  createdAt: 0,
  updatedAt: 0,
};

const chatboxList: ChatboxListItem[] = [
  {
    chatboxId: "cb-1",
    projectId: "proj-1",
    name: "Claude",
    hostStyle: "claude",
    mode: "anyone_with_link",
    allowGuestAccess: true,
    serverCount: 2,
    serverNames: ["Asana", "GitHub"],
    namedHostId: "host-1",
    namedHostName: "Claude",
    // A published scenario carries the secret token in its list row too, so
    // the redaction assertions below cover the LIST path, not just the detail.
    link: {
      token: SHARE_TOKEN,
      path: "/c/x",
      url: `https://app/c/${SHARE_TOKEN}`,
    },
    uniqueTesterCount: 3,
    lastSessionAt: 200,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    chatboxId: "cb-2",
    projectId: "proj-1",
    name: "Cursor",
    hostStyle: "chatgpt",
    mode: "anyone_with_link",
    allowGuestAccess: true,
    serverCount: 0,
    serverNames: [],
    namedHostId: "host-2",
    namedHostName: "Cursor",
    link: null,
    createdAt: 0,
    updatedAt: 0,
  },
];

const scenarioChatbox: ChatboxSettings = {
  chatboxId: "cb-1",
  projectId: "proj-1",
  name: "Claude scenario",
  hostStyle: "claude",
  systemPrompt: "",
  modelId: "anthropic/claude-haiku-4.5",
  temperature: 0.7,
  requireToolApproval: false,
  allowGuestAccess: true,
  mode: "anyone_with_link",
  servers: [
    {
      serverId: "srv-1",
      serverName: "Asana",
      useOAuth: false,
      serverUrl: null,
      clientId: null,
      oauthScopes: null,
      optional: false,
    },
    {
      serverId: "srv-2",
      serverName: "GitHub",
      useOAuth: false,
      serverUrl: null,
      clientId: null,
      oauthScopes: null,
      optional: true,
    },
  ],
  namedHostId: "host-1",
  namedHostName: "Claude",
  link: {
    token: SHARE_TOKEN,
    path: "/c/x",
    url: `https://app/c/${SHARE_TOKEN}`,
    rotatedAt: 0,
    updatedAt: 0,
  },
  members: [],
};

const sessionThreads: SharedChatThread[] = [
  {
    _id: "thread-1",
    sourceType: "chatbox",
    chatSessionId: "sess-1",
    chatboxId: "cb-1",
    startedAt: 100,
    lastActivityAt: 200,
    messageCount: 4,
    toolCallCount: 2,
    synthetic: true,
    authType: "guest",
    modelId: "anthropic/claude-haiku-4.5",
    firstMessagePreview: TRANSCRIPT,
    visitorDisplayName: VISITOR_PII,
    feedbackComment: TRANSCRIPT,
  },
];

const {
  ensureChatboxForHostMock,
  deleteChatboxMock,
  navigateMock,
  hostListState,
  chatboxState,
  usageState,
} = vi.hoisted(() => ({
  ensureChatboxForHostMock: vi.fn(),
  deleteChatboxMock: vi.fn(),
  navigateMock: vi.fn(),
  // Mutable so a case can vary the host list (ambiguity) or drop the scenario's
  // chatbox mid-test (the post-delete rerender).
  hostListState: { hosts: [] as HostListItem[], isLoading: false },
  chatboxState: { chatbox: null as ChatboxSettings | null, isLoading: false },
  usageState: {
    threads: undefined as SharedChatThread[] | undefined,
    breakdown: undefined,
    rebuild: vi.fn(),
  },
}));

vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: (name: string) =>
    name === "chatboxes:ensureChatboxForHost"
      ? ensureChatboxForHostMock
      : vi.fn(),
}));

// The surface resolves `:scenarioId` out of the host LIST — there is no
// separate host query to seed.
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => hostListState,
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxByHostId: () => chatboxState,
  useChatboxList: () => ({ chatboxes: chatboxList, isLoading: false }),
  useChatboxMutations: () => ({ deleteChatbox: deleteChatboxMock }),
}));

vi.mock("@/hooks/useUsageInsights", () => ({
  useUsageInsights: () => usageState,
}));

// Heavy children — stub so the surface mounts without their hook trees. The
// bridge (useSurfaceAgentBridge) registers before any of these render.
vi.mock("@/components/chatboxes/UserTestingScenarioDetail", () => ({
  UserTestingScenarioDetail: () => <div data-testid="stub-scenario-detail" />,
}));
vi.mock("@/components/chatboxes/UserTestingOverviewPanel", () => ({
  UserTestingOverviewPanel: () => <div data-testid="stub-overview-panel" />,
}));

import { UserTestingTab } from "@/components/UserTestingTab";

let commandSeq = 0;
async function dispatch(command: Omit<InspectorCommand, "id">) {
  commandSeq += 1;
  let response!: InspectorCommandResponse;
  await act(async () => {
    response = await executeInspectorCommand({
      ...command,
      id: `user-testing-bridge-${commandSeq}`,
    } as InspectorCommand);
  });
  return response;
}

function expectCommandError(
  response: InspectorCommandResponse
): InspectorCommandError {
  if (response.status !== "error") {
    throw new Error(
      `expected an error response, got ${JSON.stringify(response)}`
    );
  }
  return response.error;
}

function renderUserTesting(props?: {
  isAuthenticated?: boolean;
  projectId?: string | null;
  scenarioHostId?: string | null;
}) {
  return render(
    <UserTestingTab
      projectId={props?.projectId ?? "proj-1"}
      isAuthenticated={props?.isAuthenticated ?? true}
      scenarioHostId={props?.scenarioHostId ?? null}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hostListState.hosts = [hostClaude, hostCursor, hostJourney];
  hostListState.isLoading = false;
  chatboxState.chatbox = { ...scenarioChatbox };
  chatboxState.isLoading = false;
  usageState.threads = sessionThreads;
  ensureChatboxForHostMock.mockResolvedValue(undefined);
  deleteChatboxMock.mockResolvedValue(undefined);
});

describe("UserTestingTab — agent bridge handlers", () => {
  it("publishChatbox resolves the host, ensures its scenario, and opens it", async () => {
    renderUserTesting();
    const response = await dispatch({
      type: "publishChatbox",
      payload: { host: "Cursor" },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "chatbox_published", hostId: "host-2", name: "Cursor" },
    });
    expect(ensureChatboxForHostMock).toHaveBeenCalledWith({ hostId: "host-2" });
    // Selection is the ROUTE now (buildUserTestingScenarioPath), not in-page
    // state — a publish that ensured but never navigated leaves the agent
    // reporting a scenario the user cannot see.
    expect(navigateMock).toHaveBeenCalledWith("/user-testing/host-2");
  });

  it("publishChatbox HONORS the Swarms-owned dead-end without ensuring", async () => {
    renderUserTesting();
    const response = await dispatch({
      type: "publishChatbox",
      payload: { host: "Journey bot" },
    });
    const error = expectCommandError(response);
    expect(error.code).toBe("unsupported_in_mode");
    expect(error.message).toContain("Swarms");
    expect(ensureChatboxForHostMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown host as invalid_request on both commands", async () => {
    renderUserTesting();
    const publishError = expectCommandError(
      await dispatch({ type: "publishChatbox", payload: { host: "Nope" } })
    );
    expect(publishError.code).toBe("invalid_request");
    const deleteError = expectCommandError(
      await dispatch({ type: "deleteChatbox", payload: { host: "Nope" } })
    );
    expect(deleteError.code).toBe("invalid_request");
    expect(ensureChatboxForHostMock).not.toHaveBeenCalled();
    expect(deleteChatboxMock).not.toHaveBeenCalled();
  });

  it("rejects an AMBIGUOUS host name and asks for the id instead of guessing", async () => {
    // Two clients legitimately share a name; picking either one would publish
    // or delete the wrong scenario, so resolution refuses rather than guesses.
    hostListState.hosts = [hostClaude, hostCursor, hostCursorTwin];
    renderUserTesting();
    const error = expectCommandError(
      await dispatch({ type: "publishChatbox", payload: { host: "Cursor" } })
    );
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("id");
    expect(ensureChatboxForHostMock).not.toHaveBeenCalled();
  });

  it("deleteChatbox maps to the deleteChatbox mutation on the host's chatbox", async () => {
    renderUserTesting();
    const response = await dispatch({
      type: "deleteChatbox",
      payload: { host: "Cursor" },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "chatbox_deleted", chatboxId: "cb-2", name: "Cursor" },
    });
    expect(deleteChatboxMock).toHaveBeenCalledWith({ chatboxId: "cb-2" });
  });

  it("keeps the OPEN scenario deleted — no auto-remint after delete", async () => {
    // host-1 (Claude) is the scenario on screen and is currently published.
    const { rerender } = renderUserTesting({ scenarioHostId: "host-1" });
    const response = await dispatch({
      type: "deleteChatbox",
      payload: { host: "Claude" },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "chatbox_deleted", chatboxId: "cb-1" },
    });
    expect(deleteChatboxMock).toHaveBeenCalledWith({ chatboxId: "cb-1" });

    // The reactive query now reports null for the deleted host. Without the
    // suppression latch, the back-mint effect would call ensureChatboxForHost
    // and re-provision it — contradicting chatbox_deleted.
    chatboxState.chatbox = null;
    await act(async () => {
      rerender(
        <UserTestingTab
          projectId="proj-1"
          isAuthenticated
          scenarioHostId="host-1"
        />
      );
    });
    expect(ensureChatboxForHostMock).not.toHaveBeenCalledWith({
      hostId: "host-1",
    });
    // …and the screen says so instead of spinning on a provisioning that the
    // latch is deliberately holding off.
    expect(await screen.findByText(/Scenario deleted/i)).toBeInTheDocument();
  });

  it("refuses every command as unsupported_in_mode when signed out", async () => {
    renderUserTesting({ isAuthenticated: false });
    const deleteError = expectCommandError(
      await dispatch({ type: "deleteChatbox", payload: { host: "Cursor" } })
    );
    expect(deleteError.code).toBe("unsupported_in_mode");
    const publishError = expectCommandError(
      await dispatch({ type: "publishChatbox", payload: { host: "Cursor" } })
    );
    expect(publishError.code).toBe("unsupported_in_mode");
    expect(deleteChatboxMock).not.toHaveBeenCalled();
    expect(ensureChatboxForHostMock).not.toHaveBeenCalled();
  });

  it("snapshot reports redacted state and NEVER the token / transcript / PII", async () => {
    renderUserTesting({ scenarioHostId: "host-1" });

    const snapshot = await readSurfaceSnapshot("chatboxes");
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        activeView: "detail",
        detailTab: "sessions",
        scenarioCount: 2,
        scenarios: [
          { chatboxId: "cb-1", hostId: "host-1", hasPublishLink: true },
          { chatboxId: "cb-2", hostId: "host-2", hasPublishLink: false },
        ],
        selectedHostId: "host-1",
        selectedHostName: "Claude",
        published: true,
        hasPublishLink: true,
        isStandaloneSwarmHost: false,
        sessionCount: 1,
        sessions: [
          {
            id: "thread-1",
            messageCount: 4,
            toolCallCount: 2,
            synthetic: true,
          },
        ],
      },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(SHARE_TOKEN);
    expect(serialized).not.toContain(TRANSCRIPT);
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).not.toContain("Jane Visitor");
  });
});
