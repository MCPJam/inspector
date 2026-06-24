import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpjamAgentSession } from "../use-mcpjam-agent-session";

const model = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic" as const,
};

const mockState = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stop: vi.fn(),
  setMessages: vi.fn(),
  capture: vi.fn(),
  lastTransportOptions: null as null | {
    body: () => Record<string, unknown>;
  },
  projectServers: {
    serversByName: new Map<string, string>(),
    isLoading: false,
  },
  appState: {
    projects: {},
    activeProjectId: "project-local",
    selectedServer: "",
    selectedMultipleServers: [] as string[],
    isMultiSelectMode: false,
    servers: {} as Record<string, any>,
  },
}));

vi.mock("ai", () => ({
  generateId: () => "generated-session",
  DefaultChatTransport: class MockTransport {
    constructor(options: { body: () => Record<string, unknown> }) {
      mockState.lastTransportOptions = options;
    }
  },
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: [],
    sendMessage: mockState.sendMessage,
    status: "ready",
    error: undefined,
    stop: mockState.stop,
    setMessages: mockState.setMessages,
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: mockState.capture }),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => mockState.projectServers,
}));

vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => mockState.appState,
}));

vi.mock("@/hooks/use-hosted-org-model-config", () => ({
  useHostedOrgModelConfig: () => ({}),
}));

vi.mock("@/hooks/use-persisted-model", () => ({
  usePersistedModel: () => ({ selectedModelId: model.id }),
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModelsFromOrgConfig: () => [model],
  getDefaultModel: () => model,
}));

vi.mock("@/lib/apis/web/chat-history-api", () => ({
  getChatHistoryDetail: vi.fn(),
}));

describe("useMcpjamAgentSession project server selection", () => {
  beforeEach(() => {
    mockState.sendMessage.mockClear();
    mockState.stop.mockClear();
    mockState.setMessages.mockClear();
    mockState.capture.mockClear();
    mockState.lastTransportOptions = null;
    mockState.projectServers = {
      serversByName: new Map<string, string>(),
      isLoading: false,
    };
    mockState.appState = {
      projects: {},
      activeProjectId: "project-local",
      selectedServer: "",
      selectedMultipleServers: [],
      isMultiSelectMode: false,
      servers: {},
    };
  });

  it("does not submit while connected server ids are still loading", () => {
    mockState.projectServers = {
      serversByName: new Map<string, string>(),
      isLoading: true,
    };
    mockState.appState.selectedMultipleServers = ["asana"];
    mockState.appState.servers = {
      asana: {
        connectionStatus: "connected",
        oauthTokens: { access_token: "asana-token" },
      },
    };

    const { result } = renderHook(() =>
      useMcpjamAgentSession({ projectId: "proj_1" })
    );

    expect(result.current.serversReady).toBe(false);
    act(() => result.current.submit("use asana"));

    expect(mockState.sendMessage).not.toHaveBeenCalled();
  });

  it("posts the app-selected connected servers and OAuth tokens once ids resolve", () => {
    mockState.projectServers = {
      serversByName: new Map<string, string>([
        ["asana", "srv_asana"],
        ["github", "srv_github"],
      ]),
      isLoading: false,
    };
    mockState.appState.selectedMultipleServers = ["asana"];
    mockState.appState.servers = {
      asana: {
        connectionStatus: "connected",
        oauthTokens: { access_token: "asana-token" },
      },
      github: {
        connectionStatus: "connected",
        oauthTokens: { access_token: "github-token" },
      },
    };

    const { result } = renderHook(() =>
      useMcpjamAgentSession({ projectId: "proj_1" })
    );

    expect(result.current.serversReady).toBe(true);
    act(() => result.current.submit("use asana"));

    expect(mockState.sendMessage).toHaveBeenCalledWith({ text: "use asana" });
    expect(mockState.lastTransportOptions?.body()).toMatchObject({
      projectId: "proj_1",
      chatSessionId: "generated-session",
      selectedServerIds: ["srv_asana"],
      selectedServerNames: ["asana"],
      oauthTokens: { srv_asana: "asana-token" },
    });
  });
});
