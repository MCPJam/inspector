import { useState } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { UIMessage } from "ai";
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

const startChatWithMessages = vi.fn();

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
    startChatWithMessages,
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

const seedMessages: UIMessage[] = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
  },
];

describe("MultiModelChatCard", () => {
  beforeEach(() => {
    startChatWithMessages.mockClear();
  });

  it("does not loop when parent passes inline summary handlers", () => {
    render(<Harness />);

    expect(screen.getByTestId("compare-card-header")).toHaveTextContent(
      "GPT-5 Mini",
    );
    expect(screen.getByTestId("summary-count")).toHaveTextContent("1");
    expect(screen.getByTestId("message-flag-count")).toHaveTextContent("1");
  });

  it("hydrates from compareEnterVersion and compareEnterMessages once", () => {
    render(
      <MultiModelChatCard
        model={model}
        comparisonSummaries={[]}
        selectedServers={[]}
        selectedServerInstructions={{}}
        broadcastRequest={null}
        stopRequestId={0}
        placeholder="Message"
        reasoningDisplayMode="inline"
        initialSystemPrompt=""
        initialTemperature={0.7}
        initialRequireToolApproval={false}
        onSummaryChange={() => {}}
        compareEnterVersion={1}
        compareEnterMessages={seedMessages}
      />,
    );

    expect(startChatWithMessages).toHaveBeenCalledTimes(1);
    expect(startChatWithMessages).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "u1", role: "user" }),
      ]),
    );
  });

  it("prefers addColumnSeed over compare enter when both apply", () => {
    const addSeed = {
      version: 1,
      messages: [
        {
          id: "lead",
          role: "user" as const,
          parts: [{ type: "text" as const, text: "from-lead" }],
        },
      ],
    };

    render(
      <MultiModelChatCard
        model={model}
        comparisonSummaries={[]}
        selectedServers={[]}
        selectedServerInstructions={{}}
        broadcastRequest={null}
        stopRequestId={0}
        placeholder="Message"
        reasoningDisplayMode="inline"
        initialSystemPrompt=""
        initialTemperature={0.7}
        initialRequireToolApproval={false}
        onSummaryChange={() => {}}
        compareEnterVersion={1}
        compareEnterMessages={seedMessages}
        addColumnSeed={addSeed}
      />,
    );

    expect(startChatWithMessages).toHaveBeenCalledTimes(1);
    expect(startChatWithMessages).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ parts: expect.any(Array) }),
      ]),
    );
    const arg = startChatWithMessages.mock.calls[0][0];
    expect(arg.some((m) => m.id === "lead")).toBe(true);
  });
});
