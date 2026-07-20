/**
 * ChatboxesTab agent bridge handlers (S6). Commands are dispatched through the
 * real command bus against a mounted ChatboxesTab; the ensure/delete mutations,
 * host list, chatbox list, and the Generate-with-AI endpoints are mocked so the
 * handlers act through the SAME callbacks the buttons/dialogs use.
 *
 * Findings this pins:
 * - publish resolves a host, calls ensureChatboxForHost, and selects it;
 * - publish HONORS the Swarms-owned dead-end (unsupported_in_mode, no ensure);
 * - delete maps to deleteChatbox; unknown host → invalid_request;
 * - the snapshot reports redacted state and NEVER the share token / transcript
 *   text / visitor PII.
 */
import { act, render } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";
import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";

const SHARE_TOKEN = "SECRET-SHARE-TOKEN-do-not-leak";
const TRANSCRIPT = "TRANSCRIPT-CONTENTS-do-not-leak";
const VISITOR_PII = "Jane Visitor <jane@example.com>";

const hostClaude = {
  hostId: "host-1",
  name: "Claude",
  hostConfigId: "cfg-1",
  modelId: "anthropic/claude-haiku-4.5",
  serverCount: 1,
  ownerScope: null,
  createdAt: 0,
  updatedAt: 0,
};
const hostCursor = {
  hostId: "host-2",
  name: "Cursor",
  hostConfigId: "cfg-2",
  modelId: "anthropic/claude-sonnet-4.5",
  serverCount: 0,
  ownerScope: null,
  createdAt: 0,
  updatedAt: 0,
};
const hostJourney = {
  hostId: "host-3",
  name: "Journey bot",
  hostConfigId: "cfg-3",
  modelId: "anthropic/claude-haiku-4.5",
  serverCount: 0,
  ownerScope: { type: "journeys" as const },
  createdAt: 0,
  updatedAt: 0,
};

const chatboxList = [
  { chatboxId: "cb-1", namedHostId: "host-1", namedHostName: "Claude", name: "Claude" },
  { chatboxId: "cb-2", namedHostId: "host-2", namedHostName: "Cursor", name: "Cursor" },
];

const previewedChatbox = {
  chatboxId: "cb-1",
  projectId: "proj-1",
  name: "Claude chatbox",
  modelId: "anthropic/claude-haiku-4.5",
  servers: [
    { serverId: "srv-1", serverName: "Asana", optional: false },
    { serverId: "srv-2", serverName: "GitHub", optional: true },
  ],
  namedHostId: "host-1",
  namedHostName: "Claude",
  link: { token: SHARE_TOKEN, path: "/c/x", url: "https://app/c/x", rotatedAt: 0, updatedAt: 0 },
};

const sessionThreads = [
  {
    _id: "thread-1",
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
  setPreviewedHostIdMock,
  authFetchMock,
} = vi.hoisted(() => ({
  ensureChatboxForHostMock: vi.fn(),
  deleteChatboxMock: vi.fn(),
  setPreviewedHostIdMock: vi.fn(),
  authFetchMock: vi.fn(),
}));

// Mutable so individual tests can vary the previewed chatbox / model.
let currentChatbox: any = previewedChatbox;
let currentThreads: any[] = sessionThreads;

vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  // ChatboxesTab's only direct useMutation is ensureChatboxForHost.
  useMutation: () => ensureChatboxForHostMock,
}));

vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => ["host-1", setPreviewedHostIdMock],
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [hostClaude, hostCursor, hostJourney],
    isLoading: false,
  }),
  useHost: ({ hostId }: { hostId: string | null }) => ({
    host:
      hostId === "host-1"
        ? { hostId: "host-1", name: "Claude", config: {}, ownerScope: null }
        : null,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxByHostId: () => ({ chatbox: currentChatbox, isLoading: false }),
  useChatboxList: () => ({ chatboxes: chatboxList, isLoading: false }),
  useChatboxMutations: () => ({ deleteChatbox: deleteChatboxMock }),
}));

vi.mock("@/hooks/useUsageInsights", () => ({
  useUsageInsights: () => ({
    threads: currentThreads,
    breakdown: undefined,
    rebuild: vi.fn(),
  }),
}));

vi.mock("@/lib/session-token", () => ({ authFetch: authFetchMock }));

// Heavy children — stub so the surface mounts without their hook trees. The
// bridge (useSurfaceAgentBridge) registers before any of these render.
vi.mock("@/components/chatboxes/ChatboxPublishClientBar", () => ({
  ChatboxPublishClientBar: () => <div data-testid="stub-publish-bar" />,
  ChatboxHostPickerPill: () => <div data-testid="stub-host-pill" />,
}));
vi.mock("@/components/chatboxes/ChatboxShareSection", () => ({
  ChatboxShareSection: () => <div data-testid="stub-share" />,
}));
vi.mock("@/components/chatboxes/ChatboxUsagePanel", () => ({
  ChatboxUsagePanel: () => <div data-testid="stub-usage" />,
}));
vi.mock("@/components/chatboxes/PersonasTab", () => ({
  PersonasTab: () => <div data-testid="stub-personas" />,
}));
vi.mock("@/components/chatboxes/ChatboxHostCanvasPanel", () => ({
  ChatboxHostCanvasPanel: () => <div data-testid="stub-canvas" />,
}));
vi.mock("@/components/shared/view-mode-selector", () => ({
  ViewModeSelector: () => <div data-testid="stub-view-mode" />,
}));

import { ChatboxesTab } from "@/components/ChatboxesTab";

let commandSeq = 0;
async function dispatch(command: Omit<InspectorCommand, "id">) {
  commandSeq += 1;
  let response!: InspectorCommandResponse;
  await act(async () => {
    response = await executeInspectorCommand({
      ...command,
      id: `chatbox-bridge-${commandSeq}`,
    } as InspectorCommand);
  });
  return response;
}

function renderChatboxes(props?: {
  product?: "chatbox" | "swarm";
  isAuthenticated?: boolean;
  projectId?: string | null;
}) {
  render(
    <ChatboxesTab
      projectId={props?.projectId ?? "proj-1"}
      isAuthenticated={props?.isAuthenticated ?? true}
      product={props?.product ?? "swarm"}
    />,
  );
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentChatbox = { ...previewedChatbox };
  currentThreads = sessionThreads;
  ensureChatboxForHostMock.mockResolvedValue(undefined);
  deleteChatboxMock.mockResolvedValue(undefined);
});

describe("ChatboxesTab — agent bridge handlers", () => {
  it("publishChatbox resolves the host, ensures its chatbox, and selects it", async () => {
    renderChatboxes();
    const response = await dispatch({
      type: "publishChatbox",
      payload: { host: "Cursor" },
    });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "chatbox_published", hostId: "host-2", name: "Cursor" },
    });
    expect(ensureChatboxForHostMock).toHaveBeenCalledWith({ hostId: "host-2" });
    expect(setPreviewedHostIdMock).toHaveBeenCalledWith("host-2");
  });

  it("publishChatbox HONORS the Swarms-owned dead-end without ensuring", async () => {
    renderChatboxes();
    const response = await dispatch({
      type: "publishChatbox",
      payload: { host: "Journey bot" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "unsupported_in_mode" },
    });
    expect((response as any).error.message).toContain("Swarms");
    expect(ensureChatboxForHostMock).not.toHaveBeenCalled();
  });

  it("publishChatbox rejects an unknown host as invalid_request", async () => {
    renderChatboxes();
    const response = await dispatch({
      type: "publishChatbox",
      payload: { host: "Nope" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
    expect(ensureChatboxForHostMock).not.toHaveBeenCalled();
  });

  it("deleteChatbox maps to the deleteChatbox mutation on the host's chatbox", async () => {
    renderChatboxes();
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

  it("keeps the PREVIEWED host's chatbox deleted — no auto-remint after delete", async () => {
    // host-1 (Claude) is the previewed host and is currently published.
    const { rerender } = render(
      <ChatboxesTab projectId="proj-1" isAuthenticated product="swarm" />,
    );
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
    // suppression, the back-mint effect would call ensureChatboxForHost and
    // re-provision it — contradicting chatbox_deleted.
    currentChatbox = null;
    await act(async () => {
      rerender(
        <ChatboxesTab projectId="proj-1" isAuthenticated product="swarm" />,
      );
    });
    expect(ensureChatboxForHostMock).not.toHaveBeenCalledWith({
      hostId: "host-1",
    });
  });

  it("deleteChatbox rejects an unknown host without touching the mutation", async () => {
    renderChatboxes();
    const response = await dispatch({
      type: "deleteChatbox",
      payload: { host: "Nope" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
    expect(deleteChatboxMock).not.toHaveBeenCalled();
  });

  it("refuses every command as unsupported_in_mode when signed out", async () => {
    renderChatboxes({ isAuthenticated: false });
    const response = await dispatch({
      type: "deleteChatbox",
      payload: { host: "Cursor" },
    });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "unsupported_in_mode" },
    });
    expect(deleteChatboxMock).not.toHaveBeenCalled();
  });

  it("snapshot reports redacted state and NEVER the token / transcript / PII", async () => {
    renderChatboxes({ product: "swarm" });

    const snapshot = await readSurfaceSnapshot("chatboxes");
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        product: "swarm",
        selectedHostId: "host-1",
        published: true,
        hasPublishLink: true,
        isStandaloneSwarmHost: false,
        syntheticSessionsAllowed: true,
        sessionCount: 1,
        sessions: [
          { id: "thread-1", messageCount: 4, toolCallCount: 2, synthetic: true },
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
