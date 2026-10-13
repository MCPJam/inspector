import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MultiModelPlaygroundCard } from "../multi-model-playground-card";
import type { MultiModelCardSummary } from "@/components/chat-v2/model-compare-card-header";
import type { LiveChatTraceEnvelope } from "@/shared/live-chat-trace";
import { useBrowserComparisonStore } from "@/stores/browser-comparison-store";

vi.mock("use-stick-to-bottom", () => {
  const StickToBottomComponent = ({
    children,
  }: {
    children: import("react").ReactNode;
  }) => <div data-testid="stick-to-bottom">{children}</div>;
  StickToBottomComponent.Content = ({
    children,
  }: {
    children: import("react").ReactNode;
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
  addToolApprovalResponse: vi.fn(),
  systemPrompt: "",
  startChatWithMessages: vi.fn(),
};

const lane = vi.hoisted(() => ({
  chatOptions: vi.fn(),
  owner: vi.fn(),
  view: vi.fn(),
}));
vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: (options: unknown) => {
    lane.chatOptions(options);
    return mockUseChatSession;
  },
}));
vi.mock("@/components/host-workspace/ThreadAppPanel", () => ({
  useThreadAppWorkspace: (scope: unknown, servers: unknown, options: unknown) => {
    lane.owner(scope, servers, options);
    return { scope, contextReferences: scope ? ["lane-context"] : [] };
  },
}));
vi.mock("@/components/host-workspace/CompareLaneWorkspace", () => ({
  CompareLaneWorkspace: (props: {
    apps: unknown;
    showDiagnostics: boolean;
    diagnostics: import("react").ReactNode;
    children: import("react").ReactNode;
  }) => {
    lane.view(props);
    return props.showDiagnostics ? props.diagnostics : props.children;
  },
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
  const actual =
    await importOriginal<
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
    children: import("react").ReactNode;
  }) => <>{children}</>,
  useScenarioChatUiOverride: () => undefined,
}));

vi.mock("@/contexts/scenario-client-capabilities-override-context", () => ({
  ScenarioHostCapabilitiesOverrideProvider: ({
    children,
  }: {
    children: import("react").ReactNode;
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
    children: import("react").ReactNode;
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

function Harness({ browserWorkspace, extensionBinding }: {
  browserWorkspace?: { id: string; order: number; clientCount: number };
  extensionBinding?: Parameters<
    typeof MultiModelPlaygroundCard
  >[0]["extensionBinding"];
}) {
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
        extensionBinding={extensionBinding}
        browserWorkspace={browserWorkspace}
        hostedContext={{ projectId: "project-1", selectedServerIds: [] }}
        compareId={String(model.id)}
        compareLabel={model.name}
        compareKind="model"
        model={model}
        comparisonSummaries={Object.values(summaries)}
        selectedServers={[]}
        broadcastRequest={null}
        deterministicExecutionRequest={null}
        stopRequestId={0}
        executionConfig={{ systemPrompt: "", temperature: 0.7, requireToolApproval: false }}
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

describe("MultiModelPlaygroundCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBrowserComparisonStore.setState({ clients: {}, selected: {} });
  });

  it("gives a lane with extensions its own owner, shared by its chat turns and its Apps", () => {
    const binding = {
      identity: { actorId: "actor", projectId: "project-1", hostId: "host" },
      servers: [{ serverId: "saved", name: "Saved" }],
      capabilities: {} as never,
      profile: "codex" as const,
    };
    const { rerender } = render(<Harness extensionBinding={binding} />);
    const options = lane.chatOptions.mock.calls.at(-1)![0];
    const [scope, servers, ownerOptions] = lane.owner.mock.calls.at(-1)!;
    const workspace = options.pluginWorkspace("chat-session-1");
    expect(workspace.workspaceId).toMatch(/^compare:/);
    expect(scope).toEqual({
      projectId: "project-1",
      hostId: "host",
      threadId: "chat-session-1",
      pluginWorkspace: workspace,
    });
    expect(servers).toEqual(binding.servers);
    expect(ownerOptions.launchProfile).toBe("codex");
    // The lane's Apps' context rides on the lane's own turns only.
    expect(options.pluginContextReferences(workspace.workspaceId)).toEqual([
      "lane-context",
    ]);
    expect(options.pluginContextReferences("another")).toEqual([]);
    expect(lane.view.mock.calls.at(-1)![0].apps).toMatchObject({ scope });
    // Another lane never shares the workspace.
    expect(workspace.workspaceId).toContain('"model"');
    rerender(<Harness extensionBinding={null} />);
    expect(lane.owner.mock.calls.at(-1)![0]).toBeNull();
    expect(
      lane.chatOptions.mock.calls.at(-1)![0].pluginWorkspace("chat-session-1"),
    ).toBeUndefined();
    expect(lane.view.mock.calls.at(-1)![0].apps).toBeNull();
  });

  it("registers the model's own conversation under the shared browser workspace", () => {
    const view = render(
      <Harness browserWorkspace={{ id: "parent-chat", order: 1, clientCount: 2 }} />,
    );
    expect(useBrowserComparisonStore.getState().clients).toEqual({
      "chat-session-1": expect.objectContaining({
        workspaceId: "parent-chat",
        projectId: "project-1",
        sessionId: "chat-session-1",
        clientId: model.id,
        name: model.name,
        order: 1,
        clientCount: 2,
        started: false,
      }),
    });
    view.unmount();
    expect(useBrowserComparisonStore.getState().clients).toEqual({});
  });

  it("does not loop when parent passes inline summary handlers", () => {
    render(<Harness />);

    expect(screen.getByTestId("compare-card-header")).toHaveTextContent(
      "GPT-5 Mini",
    );
    expect(screen.getByTestId("summary-count")).toHaveTextContent("1");
    expect(screen.getByTestId("message-flag-count")).toHaveTextContent("1");
  });

  it("omits compare header chrome when showComparisonChrome is false (matches chat tab single-column compare)", () => {
    render(
      <MultiModelPlaygroundCard
        compareId={String(model.id)}
        compareLabel={model.name}
        compareKind="model"
        model={model}
        comparisonSummaries={[]}
        selectedServers={[]}
        broadcastRequest={null}
        deterministicExecutionRequest={null}
        stopRequestId={0}
        executionConfig={{ systemPrompt: "", temperature: 0.7, requireToolApproval: false }}
        displayMode="inline"
        onDisplayModeChange={vi.fn()}
        hostStyle="chatgpt"
        effectiveThreadTheme="light"
        deviceType="mobile"
        onSummaryChange={vi.fn()}
        showComparisonChrome={false}
      />,
    );

    expect(screen.queryByTestId("compare-card-header")).not.toBeInTheDocument();
  });

  it("hides shared-message empty hint when suppressThreadEmptyHint is true", () => {
    render(
      <MultiModelPlaygroundCard
        compareId={String(model.id)}
        compareLabel={model.name}
        compareKind="model"
        model={model}
        comparisonSummaries={[]}
        selectedServers={[]}
        broadcastRequest={null}
        deterministicExecutionRequest={null}
        stopRequestId={0}
        executionConfig={{ systemPrompt: "", temperature: 0.7, requireToolApproval: false }}
        displayMode="inline"
        onDisplayModeChange={vi.fn()}
        hostStyle="chatgpt"
        effectiveThreadTheme="light"
        deviceType="mobile"
        onSummaryChange={vi.fn()}
        suppressThreadEmptyHint
      />,
    );

    expect(
      screen.queryByText("Send a shared message to start this model’s thread."),
    ).not.toBeInTheDocument();
  });

  it("calls stop when stopRequestId changes", async () => {
    const { rerender } = render(
      <MultiModelPlaygroundCard
        compareId={String(model.id)}
        compareLabel={model.name}
        compareKind="model"
        model={model}
        comparisonSummaries={[]}
        selectedServers={[]}
        broadcastRequest={null}
        deterministicExecutionRequest={null}
        stopRequestId={0}
        executionConfig={{ systemPrompt: "", temperature: 0.7, requireToolApproval: false }}
        displayMode="inline"
        onDisplayModeChange={vi.fn()}
        hostStyle="chatgpt"
        effectiveThreadTheme="light"
        deviceType="mobile"
        onSummaryChange={vi.fn()}
      />,
    );

    rerender(
      <MultiModelPlaygroundCard
        compareId={String(model.id)}
        compareLabel={model.name}
        compareKind="model"
        model={model}
        comparisonSummaries={[]}
        selectedServers={[]}
        broadcastRequest={null}
        deterministicExecutionRequest={null}
        stopRequestId={1}
        executionConfig={{ systemPrompt: "", temperature: 0.7, requireToolApproval: false }}
        displayMode="inline"
        onDisplayModeChange={vi.fn()}
        hostStyle="chatgpt"
        effectiveThreadTheme="light"
        deviceType="mobile"
        onSummaryChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mockUseChatSession.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe("summary while streaming", () => {
    const idleSession = { ...mockUseChatSession };

    afterEach(() => {
      Object.assign(mockUseChatSession, idleSession);
    });

    // `useChatSession` rebuilds the live trace envelope on every trace event,
    // and the server emits one per text token, so each token hands the card a
    // new turn object carrying the same numbers.
    const envelopeAtToken = (
      usage?: LiveChatTraceEnvelope["usage"],
    ): LiveChatTraceEnvelope => ({
      traceVersion: 1,
      messages: [],
      turns: [
        {
          turnId: "turn-1",
          promptIndex: 0,
          durationMs: 0,
          usage,
          actualToolCalls: [],
        },
      ],
    });

    const streamingCard = (
      onSummaryChange: (summary: MultiModelCardSummary) => void,
    ) => (
      <MultiModelPlaygroundCard
        compareId={String(model.id)}
        compareLabel={model.name}
        compareKind="model"
        model={model}
        comparisonSummaries={[]}
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
        deviceType="desktop"
        onSummaryChange={onSummaryChange}
      />
    );

    // INSPECTOR-CLIENT-2HP: in compare mode the parent stores each lifted
    // summary with `setCompareSummaries`. Lifting once per token, per card,
    // stacked enough nested updates on a fast stream to trip React's
    // "Maximum update depth exceeded".
    it("lifts the summary when its numbers change, not on every streamed token", () => {
      Object.assign(mockUseChatSession, {
        messages: [
          { id: "m-1", role: "user", parts: [{ type: "text", text: "hi" }] },
        ],
        status: "streaming",
        isStreaming: true,
        liveTraceEnvelope: envelopeAtToken(),
      });
      const onSummaryChange = vi.fn();
      const { rerender } = render(streamingCard(onSummaryChange));
      expect(onSummaryChange).toHaveBeenCalledTimes(1);

      for (let token = 0; token < 100; token++) {
        Object.assign(mockUseChatSession, {
          liveTraceEnvelope: envelopeAtToken(),
        });
        rerender(streamingCard(onSummaryChange));
      }
      expect(onSummaryChange).toHaveBeenCalledTimes(1);

      Object.assign(mockUseChatSession, {
        liveTraceEnvelope: envelopeAtToken({
          inputTokens: 30,
          outputTokens: 12,
          totalTokens: 42,
        }),
      });
      rerender(streamingCard(onSummaryChange));
      expect(onSummaryChange).toHaveBeenCalledTimes(2);
      expect(onSummaryChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "running", tokens: 42 }),
      );
    });
  });

  describe("height layout", () => {
    beforeEach(() => {
      mockUseChatSession.messages = [];
      mockUseChatSession.isStreaming = false;
    });

    it("card root has no forced min-height so it can shrink inside a short grid row", () => {
      render(
        <MultiModelPlaygroundCard
          compareId={String(model.id)}
          compareLabel={model.name}
          compareKind="model"
          model={model}
          comparisonSummaries={[]}
          selectedServers={[]}
          broadcastRequest={null}
          deterministicExecutionRequest={null}
          stopRequestId={0}
          executionConfig={{ systemPrompt: "", temperature: 0.7, requireToolApproval: false }}
          displayMode="inline"
          onDisplayModeChange={vi.fn()}
          hostStyle="chatgpt"
          effectiveThreadTheme="light"
          deviceType="desktop"
          onSummaryChange={vi.fn()}
        />,
      );

      const root = screen.getByTestId("multi-model-playground-card-root");
      expect(root.className).not.toMatch(/min-h-\[\d+rem\]/);
      expect(root.className).toContain("min-h-0");
    });

    it("shell drops its min-height in default desktop inline compare", () => {
      mockUseChatSession.messages = [
        { id: "m-1", role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          id: "m-2",
          role: "assistant",
          parts: [{ type: "text", text: "hello" }],
        },
      ] as (typeof mockUseChatSession)["messages"];

      const { container } = render(
        <MultiModelPlaygroundCard
          compareId={String(model.id)}
          compareLabel={model.name}
          compareKind="model"
          model={model}
          comparisonSummaries={[]}
          selectedServers={[]}
          broadcastRequest={null}
          deterministicExecutionRequest={null}
          stopRequestId={0}
          executionConfig={{ systemPrompt: "", temperature: 0.7, requireToolApproval: false }}
          displayMode="inline"
          onDisplayModeChange={vi.fn()}
          hostStyle="chatgpt"
          effectiveThreadTheme="light"
          deviceType="desktop"
          onSummaryChange={vi.fn()}
        />,
      );

      const shell = container.querySelector(".scenario-host-shell");
      expect(shell).not.toBeNull();
      expect(shell!.className).not.toContain("min-h-[");
    });

    it("shell keeps its 34rem floor when rendering a mobile fullscreen device frame", () => {
      mockUseChatSession.messages = [
        { id: "m-1", role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          id: "m-2",
          role: "assistant",
          parts: [{ type: "text", text: "hello" }],
        },
      ] as (typeof mockUseChatSession)["messages"];

      const { container } = render(
        <MultiModelPlaygroundCard
          compareId={String(model.id)}
          compareLabel={model.name}
          compareKind="model"
          model={model}
          comparisonSummaries={[]}
          selectedServers={[]}
          broadcastRequest={null}
          deterministicExecutionRequest={null}
          stopRequestId={0}
          executionConfig={{ systemPrompt: "", temperature: 0.7, requireToolApproval: false }}
          displayMode="fullscreen"
          onDisplayModeChange={vi.fn()}
          hostStyle="chatgpt"
          effectiveThreadTheme="light"
          deviceType="mobile"
          onSummaryChange={vi.fn()}
        />,
      );

      const shell = container.querySelector(".scenario-host-shell");
      expect(shell).not.toBeNull();
      expect(shell!.className).toContain("min-h-[34rem]");
    });
  });
});
