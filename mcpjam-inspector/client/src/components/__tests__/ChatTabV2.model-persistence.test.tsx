/**
 * BACK2-628 follow-up: the selected-model sanitize effect in ChatTabV2 writes
 * the *global* lead localStorage key (`setSelectedModelIds` ends in
 * `saveSelectedModelId(normalized[0] ?? null)` — see
 * `use-persisted-model.ts:150-159`). Anything it mirrors back into storage
 * while the real selection has not resolved destroys the user's own-provider
 * pick, which is what made the model look like it never stuck across chats.
 *
 * These suites drive that effect directly. `setSelectedModelIds` below is
 * wired to the real `saveSelectedModelId` so the assertions are on the key
 * that actually gets clobbered, rather than on a spy that only stands in for
 * it.
 */
import type { CSSProperties, ReactNode } from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveSelectedModelId } from "@/lib/selected-model-storage";
import { ChatTabV2 } from "../ChatTabV2";

const LEAD_KEY = "mcp-inspector-selected-model";

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    signUp: vi.fn(),
  }),
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({ mutation: vi.fn().mockResolvedValue({ ok: true }) }),
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
  useQuery: (_name: string, args: unknown) =>
    args === "skip" ? undefined : null,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn(() => "test"),
  detectPlatform: vi.fn(() => "web"),
}));

vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
}));

vi.mock("@/hooks/use-json-rpc-panel", () => ({
  useJsonRpcPanelVisibility: () => ({
    isVisible: false,
    toggle: vi.fn(),
  }),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({
    serversByName: new Map(),
  }),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/session-token", () => ({
  addTokenToUrl: (url: string) => url,
  authFetch: vi.fn(),
}));

vi.mock("@/lib/oauth/oauth-tokens", () => ({
  buildOAuthTokensByServerId: vi.fn(() => ({})),
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    servers: {
      "server-1": {
        connectionStatus: "connected",
      },
    },
    projects: {},
    activeProjectId: "project-1",
  }),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

vi.mock("../logger-view", () => ({
  LoggerView: () => <div data-testid="logger-view" />,
}));

vi.mock("@/components/ElicitationDialog", () => ({
  ElicitationDialog: () => null,
}));

vi.mock("@/components/ui/collapsed-panel-strip", () => ({
  CollapsedPanelStrip: () => <div data-testid="collapsed-panel-strip" />,
}));

vi.mock("@/components/chat-v2/mcpjam-free-models-prompt", () => ({
  MCPJamFreeModelsPrompt: () => <div data-testid="upsell-prompt" />,
}));

vi.mock("@/components/chat-v2/error", () => ({
  ErrorBox: ({ message }: { message: string }) => (
    <div data-testid="error-box">{message}</div>
  ),
}));

vi.mock("@/components/chat-v2/shared/chat-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/chat-v2/shared/chat-helpers")
    >();
  return {
    ...actual,
    STARTER_PROMPTS: [],
    formatErrorMessage: (error: Error | null) =>
      error ? { message: error.message } : null,
    buildMcpPromptMessages: () => [],
    buildSkillToolMessages: () => [],
  };
});

vi.mock("@/components/chat-v2/chat-input/attachments/file-utils", () => ({
  attachmentsToFileUIParts: vi.fn(async () => []),
  revokeFileAttachmentUrls: vi.fn(),
}));

vi.mock("use-stick-to-bottom", () => {
  const StickToBottomComponent = ({
    children,
    style,
  }: {
    children: ReactNode;
    style?: CSSProperties;
  }) => (
    <div data-testid="stick-to-bottom" style={style}>
      {children}
    </div>
  );
  StickToBottomComponent.Content = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );

  return {
    StickToBottom: StickToBottomComponent,
    useStickToBottomContext: () => ({
      isAtBottom: true,
      scrollToBottom: vi.fn(),
    }),
  };
});

vi.mock("@/components/chat-v2/chat-input", () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock("@/components/chat-v2/thread", () => ({
  Thread: ({ messages }: { messages: any[] }) => (
    <div data-testid="thread" data-message-count={messages.length} />
  ),
}));

vi.mock("@/components/chat-v2/multi-model-chat-card", () => ({
  MultiModelChatCard: (props: { model: { name: string } }) => (
    <div data-testid="multi-model-card">{props.model.name}</div>
  ),
}));

vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: () => <div data-testid="trace-viewer" />,
}));

vi.mock("@/components/evals/trace-view-mode-tabs", () => ({
  TraceViewModeTabs: () => <div data-testid="trace-view-tabs" />,
  ChatTraceViewModeHeaderBar: () => <div data-testid="trace-view-tabs" />,
}));

/** The user's own-provider pick, sitting in localStorage from a prior chat. */
const OWN_PROVIDER_MODEL_ID = "claude-haiku-4-5";

/**
 * What `selectedModel` degrades to while `useHostedOrgModelConfig` is in
 * flight: `composeAvailableModels` takes the local-BYOK branch, the org-key
 * model is absent, and `getDefaultModel` hands back a fallback.
 */
const derivedFallbackModel = {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  provider: "anthropic",
};

const mockUseChatSession = {
  pendingElicitations: [],
  respondToElicitation: vi.fn(),
  elicitationResponding: false,
  urlElicitationRequired: [],
  dismissUrlElicitationRequired: vi.fn(),
  messages: [],
  setMessages: vi.fn(),
  sendMessage: vi.fn(),
  stop: vi.fn(),
  status: "ready",
  error: undefined,
  chatSessionId: "chat-session-1",
  selectedModel: derivedFallbackModel,
  setSelectedModel: vi.fn(),
  isSelectedModelResolved: true,
  selectedModelIds: [] as string[],
  // Mirrors `use-persisted-model.ts:150-159` — the lead key write is the whole
  // point of these tests, so the fake must do it too.
  setSelectedModelIds: vi.fn((modelIds: string[]) => {
    saveSelectedModelId(modelIds[0] ?? null);
  }),
  multiModelEnabled: false,
  setMultiModelEnabled: vi.fn(),
  availableModels: [] as any[],
  isMcpJamModel: true,
  isAuthenticated: true,
  isAuthLoading: false,
  authHeaders: undefined,
  isAuthReady: true,
  isSessionBootstrapComplete: true,
  systemPrompt: "",
  setSystemPrompt: vi.fn(),
  temperature: 0.7,
  setTemperature: vi.fn(),
  toolsMetadata: {},
  toolServerMap: {},
  tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  mcpToolsTokenCount: null,
  mcpToolsTokenCountLoading: false,
  systemPromptTokenCount: null,
  systemPromptTokenCountLoading: false,
  requireToolApproval: false,
  setRequireToolApproval: vi.fn(),
  addToolApprovalResponse: vi.fn(),
  resetChat: vi.fn(),
  startChatWithMessages: vi.fn(),
  liveTraceEnvelope: null,
  requestPayloadHistory: [],
  hasTraceSnapshot: false,
  hasLiveTimelineContent: false,
  traceViewsSupported: false,
  isStreaming: false,
  disableForAuthentication: false,
  submitBlocked: false,
} as any;

vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: () => mockUseChatSession,
}));

describe("ChatTabV2 selected-model persistence", () => {
  const defaultProps = {
    connectedOrConnectingServerConfigs: {
      "server-1": {
        name: "server-1",
        connectionStatus: "connected",
      },
    } as any,
    selectedServerNames: ["server-1"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.assign(mockUseChatSession, {
      messages: [],
      selectedModel: derivedFallbackModel,
      isSelectedModelResolved: true,
      selectedModelIds: [],
      multiModelEnabled: false,
      availableModels: [],
    });
  });

  // The multi-model toggle lives under one global key
  // (`mcp-inspector-multi-model-enabled`), so a user who turned compare on in
  // the Playground arrives here with `multiModelEnabled` already true even
  // though this surface never offers it — `enableMultiModelChat` defaults to
  // false, so `canEnableMultiModel` is false. That sends the effect down its
  // reset branch, which also writes the lead key.
  it("does not persist the derived fallback while the selection is unresolved", () => {
    localStorage.setItem(LEAD_KEY, OWN_PROVIDER_MODEL_ID);
    Object.assign(mockUseChatSession, {
      // The org config is still in flight: the persisted id is not in
      // `availableModels`, so `selectedModel` is the derived fallback.
      isSelectedModelResolved: false,
      multiModelEnabled: true,
      selectedModelIds: [OWN_PROVIDER_MODEL_ID],
    });

    render(<ChatTabV2 {...defaultProps} />);

    expect(localStorage.getItem(LEAD_KEY)).toBe(OWN_PROVIDER_MODEL_ID);
    expect(mockUseChatSession.setSelectedModelIds).not.toHaveBeenCalled();
  });

  // Deferring the reset must not drop it: `isSelectedModelResolved` is in the
  // effect's deps, so the cleanup runs on the render after the selection
  // lands.
  it("still turns the stale multi-model toggle off once the selection resolves", () => {
    localStorage.setItem(LEAD_KEY, OWN_PROVIDER_MODEL_ID);
    Object.assign(mockUseChatSession, {
      isSelectedModelResolved: false,
      multiModelEnabled: true,
      selectedModelIds: [OWN_PROVIDER_MODEL_ID],
    });

    const { rerender } = render(<ChatTabV2 {...defaultProps} />);
    expect(mockUseChatSession.setMultiModelEnabled).not.toHaveBeenCalled();

    Object.assign(mockUseChatSession, {
      isSelectedModelResolved: true,
      selectedModel: {
        id: OWN_PROVIDER_MODEL_ID,
        name: "Claude Haiku 4.5",
        provider: "anthropic",
      },
    });
    rerender(<ChatTabV2 {...defaultProps} />);

    expect(mockUseChatSession.setMultiModelEnabled).toHaveBeenCalledWith(false);
    expect(localStorage.getItem(LEAD_KEY)).toBe(OWN_PROVIDER_MODEL_ID);
  });

  it("sanitizes normally once the selection has resolved", () => {
    Object.assign(mockUseChatSession, {
      isSelectedModelResolved: true,
      selectedModel: {
        id: OWN_PROVIDER_MODEL_ID,
        name: "Claude Haiku 4.5",
        provider: "anthropic",
      },
      selectedModelIds: ["stale-model"],
    });

    render(<ChatTabV2 {...defaultProps} />);

    expect(mockUseChatSession.setSelectedModelIds).toHaveBeenCalledWith([
      OWN_PROVIDER_MODEL_ID,
    ]);
    expect(localStorage.getItem(LEAD_KEY)).toBe(OWN_PROVIDER_MODEL_ID);
  });

  // The remaining route into the lead key — a surface that pins its model via
  // `executionConfig.modelId`, where `isSelectedModelResolved` short-circuits
  // to true and this effect happily mirrors the pinned model out — is closed
  // inside `useChatSession` rather than here, so it is covered by
  // `use-chat-session.minimal-mode.test.tsx` ("does not persist the model
  // selection from a surface with a pinned model").
});
