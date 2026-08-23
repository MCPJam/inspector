import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MultiModelPlaygroundCard } from "../multi-model-playground-card";
import type { MultiModelCardSummary } from "@/components/chat-v2/model-compare-card-header";

vi.mock("use-stick-to-bottom", () => {
  const StickToBottomComponent = ({
    children,
  }: {
    children: React.ReactNode;
  }) => <div data-testid="stick-to-bottom">{children}</div>;
  StickToBottomComponent.Content = ({
    children,
  }: {
    children: React.ReactNode;
  }) => <div>{children}</div>;

  return {
    StickToBottom: StickToBottomComponent,
    useStickToBottomContext: () => ({
      isAtBottom: true,
      scrollToBottom: vi.fn(),
    }),
  };
});

const mockUseChatSession = {
  // Elicitation surface (hosted). These suites never elicit, but the shape
  // must match the hook's contract or the dialog crashes on undefined.
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
  toolsMetadata: {},
  toolServerMap: {},
  liveTraceEnvelope: null,
  requestPayloadHistory: [],
  hasTraceSnapshot: false,
  hasLiveTimelineContent: false,
  traceViewsSupported: true,
  isStreaming: false,
  isSessionBootstrapComplete: true,
  addToolApprovalResponse: vi.fn(),
  systemPrompt: "",
  startChatWithMessages: vi.fn(),
};

vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: () => mockUseChatSession,
}));

vi.mock("@/components/chat-v2/thread", () => ({
  Thread: () => <div data-testid="thread" />,
}));

vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: () => <div data-testid="trace-viewer" />,
}));

vi.mock("@/components/chat-v2/error", () => ({
  ErrorBox: () => <div data-testid="error-box" />,
}));

vi.mock("@/components/chat-v2/shared/chat-helpers", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/components/chat-v2/shared/chat-helpers")
  >();
  return {
    ...actual,
    formatErrorMessage: () => null,
  };
});

vi.mock("@/components/chat-v2/model-compare-card-header", () => ({
  ModelCompareCardHeader: ({
    model,
    showComparisonChrome = true,
    showTraceTabs,
  }: {
    model: { name: string };
    showComparisonChrome?: boolean;
    showTraceTabs: boolean;
  }) => {
    if (!showComparisonChrome && !showTraceTabs) {
      return null;
    }
    return <div data-testid="compare-card-header">{model.name}</div>;
  },
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: <T,>(selector: (state: any) => T): T =>
    selector({ hostCapabilitiesOverride: null }),
}));

vi.mock("@/contexts/scenario-client-style-context", () => ({
  ScenarioHostStyleProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  ScenarioHostThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  ScenarioChatUiOverrideProvider: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <>{children}</>,
  useScenarioChatUiOverride: () => undefined,
}));

vi.mock("@/contexts/scenario-client-capabilities-override-context", () => ({
  ScenarioHostCapabilitiesOverrideProvider: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <>{children}</>,
  useScenarioHostCapabilitiesOverride: () => undefined,
}));

vi.mock("@/contexts/active-mcp-profile-context", () => ({
  ActiveMcpProfileProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useActiveMcpProfile: () => undefined,
}));

vi.mock("@/contexts/active-host-client-capabilities-context", () => ({
  ActiveHostCapsResolverScope: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <>{children}</>,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => null,
}));

const model = {
  id: "openai/gpt-5-mini",
  name: "GPT-5 Mini",
  provider: "openai" as const,
};

function Harness() {
  const [summaries, setSummaries] = useState<
    Record<string, MultiModelCardSummary>
  >({});
  const [messageFlags, setMessageFlags] = useState<Record<string, boolean>>({});

  return (
    <div>
      <div data-testid="summary-count">{Object.keys(summaries).length}</div>
      <div data-testid="message-flag-count">
        {Object.keys(messageFlags).length}
      </div>
      <MultiModelPlaygroundCard
        compareId={String(model.id)}
        compareLabel={model.name}
        compareKind="model"
        model={model}
        comparisonSummaries={Object.values(summaries)}
        selectedServers={[]}
        broadcastRequest={null}
        deterministicExecutionRequest={null}
        stopRequestId={0}
        executionConfig={{
          systemPrompt: "",
          temperature: 0.7,
          requireToolApproval: false,
        }}
        displayMode="inline"
        onDisplayModeChange={vi.fn()}
        hostStyle="chatgpt"
        effectiveThreadTheme="light"
        deviceType="mobile"
        onSummaryChange={(summary) =>
          setSummaries((previous) => ({
            ...previous,
            [summary.modelId]: summary,
          }))
        }
        onHasMessagesChange={(modelId, hasMessages) =>
          setMessageFlags((previous) => ({
            ...previous,
            [modelId]: hasMessages,
          }))
        }
      />
    </div>
  );
}

describe("a freshly mounted card defers a queued turn until auth bootstrap", () => {
  /**
   * The card owns its OWN `useChatSession`, so it owns its own async auth
   * bootstrap. A stored `broadcastRequest` can exist on the first render after
   * a host switch. The card must leave it unconsumed until its own session
   * bootstrap completes, then replay it exactly once.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChatSession.isSessionBootstrapComplete = false;
  });

  const request = {
    id: 1,
    text: "hello",
    files: undefined,
    prependMessages: [],
    widgetModelContext: [],
  };

  function cardWithBroadcast(broadcastRequest: unknown) {
    return (
      <MultiModelPlaygroundCard
        compareId="host-1"
        compareLabel="Cursor"
        compareKind="host"
        model={model}
        comparisonSummaries={[]}
        selectedServers={[]}
        broadcastRequest={broadcastRequest as never}
        deterministicExecutionRequest={null}
        stopRequestId={0}
        executionConfig={{
          systemPrompt: "",
          temperature: 0.7,
          requireToolApproval: false,
        }}
        displayMode="inline"
        onDisplayModeChange={vi.fn()}
        hostStyle="chatgpt"
        effectiveThreadTheme="light"
        deviceType="mobile"
        onSummaryChange={vi.fn()}
        onHasMessagesChange={vi.fn()}
        showComparisonChrome={false}
      />
    );
  }

  function renderWithBroadcast(broadcastRequest: unknown) {
    return render(cardWithBroadcast(broadcastRequest));
  }

  it("defers the queued turn, then sends it once bootstrap completes", async () => {
    const view = renderWithBroadcast(request);
    expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();

    mockUseChatSession.isSessionBootstrapComplete = true;
    view.rerender(cardWithBroadcast(request));

    await waitFor(() =>
      expect(mockUseChatSession.sendMessage).toHaveBeenCalledTimes(1)
    );
    expect(mockUseChatSession.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "hello" })
    );

    view.rerender(cardWithBroadcast(request));
    expect(mockUseChatSession.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when there is nothing queued (isolates the trigger)", async () => {
    mockUseChatSession.isSessionBootstrapComplete = true;
    renderWithBroadcast(null);
    await waitFor(() => expect(true).toBe(true));
    expect(mockUseChatSession.sendMessage).not.toHaveBeenCalled();
  });
});
