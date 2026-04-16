import { useState, type ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
const mockTraceViewer = vi.fn();
const mockModelCompareCardHeader = vi.fn();

const mockUseChatSession = {
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
};

vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: () => mockUseChatSession,
}));

vi.mock("@/components/chat-v2/thread", () => ({
  Thread: () => <div data-testid="thread" />,
}));

vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: (props: {
    forcedViewMode?: "timeline" | "chat" | "raw" | "tools";
    onRevealNavigateToChat?: () => void;
    displayMode?: unknown;
    onDisplayModeChange?: unknown;
  }) => {
    mockTraceViewer(props);
    return (
      <div data-testid="trace-viewer">
        <div data-testid="trace-viewer-mode">
          {props.forcedViewMode ?? "timeline"}
        </div>
        <button
          type="button"
          onClick={() => props.onRevealNavigateToChat?.()}
        >
          Reveal Trace Chat
        </button>
      </div>
    );
  },
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
  ModelCompareCardHeader: (props: {
    model: { name: string };
    onModeChange: (mode: "chat" | "timeline" | "raw") => void;
  }) => {
    mockModelCompareCardHeader(props);
    return (
      <div>
        <div data-testid="compare-card-header">{props.model.name}</div>
        <button type="button" onClick={() => props.onModeChange("raw")}>
          Switch to Raw
        </button>
        <button type="button" onClick={() => props.onModeChange("timeline")}>
          Switch to Timeline
        </button>
      </div>
    );
  },
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
  {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "hi there" }],
  },
];

function renderCard(
  overrides: Partial<ComponentProps<typeof MultiModelChatCard>> = {},
) {
  return render(
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
      onSummaryChange={vi.fn()}
      {...overrides}
    />,
  );
}

describe("MultiModelChatCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChatSession.messages = [];
    mockUseChatSession.setMessages = vi.fn();
    mockUseChatSession.sendMessage = vi.fn();
    mockUseChatSession.stop = vi.fn();
    mockUseChatSession.status = "ready";
    mockUseChatSession.error = undefined;
    mockUseChatSession.chatSessionId = "chat-session-1";
    mockUseChatSession.toolsMetadata = {};
    mockUseChatSession.toolServerMap = {};
    mockUseChatSession.liveTraceEnvelope = null;
    mockUseChatSession.requestPayloadHistory = [];
    mockUseChatSession.hasTraceSnapshot = false;
    mockUseChatSession.hasLiveTimelineContent = false;
    mockUseChatSession.traceViewsSupported = true;
    mockUseChatSession.isStreaming = false;
    mockUseChatSession.addToolApprovalResponse = vi.fn();
    mockUseChatSession.systemPrompt = "";
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
    expect(arg.some((message) => message.id === "lead")).toBe(true);
  });

  it("calls stop when stopRequestId changes", async () => {
    const { rerender } = render(
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
        onSummaryChange={vi.fn()}
      />,
    );

    rerender(
      <MultiModelChatCard
        model={model}
        comparisonSummaries={[]}
        selectedServers={[]}
        selectedServerInstructions={{}}
        broadcastRequest={null}
        stopRequestId={1}
        placeholder="Message"
        reasoningDisplayMode="inline"
        initialSystemPrompt=""
        initialTemperature={0.7}
        initialRequireToolApproval={false}
        onSummaryChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mockUseChatSession.stop).toHaveBeenCalledTimes(1);
    });
  });

  it("does not pass display-mode props into raw and timeline compare trace viewers", () => {
    mockUseChatSession.messages = seedMessages;
    mockUseChatSession.hasLiveTimelineContent = true;

    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Raw" }));

    expect(screen.getByTestId("trace-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("trace-viewer-mode")).toHaveTextContent("raw");
    expect(mockTraceViewer).toHaveBeenCalled();
    let props = mockTraceViewer.mock.calls.at(-1)?.[0];
    expect(props.displayMode).toBeUndefined();
    expect(props.onDisplayModeChange).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Timeline" }));

    expect(screen.getByTestId("trace-viewer-mode")).toHaveTextContent(
      "timeline",
    );
    props = mockTraceViewer.mock.calls.at(-1)?.[0];
    expect(props.displayMode).toBeUndefined();
    expect(props.onDisplayModeChange).toBeUndefined();
  });

  it("does not pass display-mode props into the revealed compare trace chat branch", () => {
    mockUseChatSession.messages = seedMessages;

    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Raw" }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal Trace Chat" }));

    expect(screen.getByTestId("trace-viewer-mode")).toHaveTextContent("chat");
    const props = mockTraceViewer.mock.calls.at(-1)?.[0];
    expect(props.displayMode).toBeUndefined();
    expect(props.onDisplayModeChange).toBeUndefined();
  });
});
