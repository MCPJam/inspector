import { useState } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MultiModelChatCard } from "../multi-model-chat-card";
import type { MultiModelCardSummary } from "../model-compare-card-header";

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
    hasTraceSnapshot: false,
    hasLiveTimelineContent: false,
    traceViewsSupported: true,
    isStreaming: false,
    addToolApprovalResponse: vi.fn(),
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

vi.mock("@/components/chat-v2/shared/chat-helpers", () => ({
  formatErrorMessage: () => null,
}));

vi.mock("../model-compare-card-header", () => ({
  ModelCompareCardHeader: ({ model }: { model: { name: string } }) => (
    <div data-testid="compare-card-header">{model.name}</div>
  ),
}));

const model = {
  id: "openai/gpt-5-mini",
  name: "GPT-5 Mini",
  provider: "openai" as const,
};

function Harness() {
  const [summaries, setSummaries] = useState<Record<string, MultiModelCardSummary>>(
    {},
  );
  const [messageFlags, setMessageFlags] = useState<Record<string, boolean>>({});

  return (
    <div>
      <div data-testid="summary-count">{Object.keys(summaries).length}</div>
      <div data-testid="message-flag-count">{Object.keys(messageFlags).length}</div>
      <MultiModelChatCard
        model={model}
        comparisonSummaries={Object.values(summaries)}
        selectedServers={[]}
        selectedServerInstructions={{}}
        broadcastRequest={null}
        stopRequestId={0}
        placeholder="Message"
        reasoningDisplayMode="inline"
        initialSystemPrompt=""
        initialTemperature={0.7}
        initialRequireToolApproval={false}
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

describe("MultiModelChatCard", () => {
  it("does not loop when parent passes inline summary handlers", () => {
    render(<Harness />);

    expect(screen.getByTestId("compare-card-header")).toHaveTextContent(
      "GPT-5 Mini",
    );
    expect(screen.getByTestId("summary-count")).toHaveTextContent("1");
    expect(screen.getByTestId("message-flag-count")).toHaveTextContent("1");
  });
});
