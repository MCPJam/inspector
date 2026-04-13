import { useState } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: () => ({
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
  }),
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

vi.mock("@/contexts/sandbox-host-style-context", () => ({
  SandboxHostStyleProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SandboxHostThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
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
        model={model}
        comparisonSummaries={Object.values(summaries)}
        selectedServers={[]}
        broadcastRequest={null}
        deterministicExecutionRequest={null}
        stopRequestId={0}
        initialSystemPrompt=""
        initialTemperature={0.7}
        initialRequireToolApproval={false}
        displayMode="inline"
        onDisplayModeChange={vi.fn()}
        hostStyle="chatgpt"
        effectiveThreadTheme="light"
        deviceType="mobile"
        selectedProtocol={null}
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
        model={model}
        comparisonSummaries={[]}
        selectedServers={[]}
        broadcastRequest={null}
        deterministicExecutionRequest={null}
        stopRequestId={0}
        initialSystemPrompt=""
        initialTemperature={0.7}
        initialRequireToolApproval={false}
        displayMode="inline"
        onDisplayModeChange={vi.fn()}
        hostStyle="chatgpt"
        effectiveThreadTheme="light"
        deviceType="mobile"
        selectedProtocol={null}
        onSummaryChange={vi.fn()}
        showComparisonChrome={false}
      />,
    );

    expect(screen.queryByTestId("compare-card-header")).not.toBeInTheDocument();
  });

  it("hides shared-message empty hint when suppressThreadEmptyHint is true", () => {
    render(
      <MultiModelPlaygroundCard
        model={model}
        comparisonSummaries={[]}
        selectedServers={[]}
        broadcastRequest={null}
        deterministicExecutionRequest={null}
        stopRequestId={0}
        initialSystemPrompt=""
        initialTemperature={0.7}
        initialRequireToolApproval={false}
        displayMode="inline"
        onDisplayModeChange={vi.fn()}
        hostStyle="chatgpt"
        effectiveThreadTheme="light"
        deviceType="mobile"
        selectedProtocol={null}
        onSummaryChange={vi.fn()}
        suppressThreadEmptyHint
      />,
    );

    expect(
      screen.queryByText("Send a shared message to start this model’s thread."),
    ).not.toBeInTheDocument();
  });
});
