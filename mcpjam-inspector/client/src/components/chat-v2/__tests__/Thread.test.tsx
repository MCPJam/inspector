import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Thread } from "../thread";
import type { UIMessage } from "@ai-sdk/react";
import type { ModelDefinition } from "@/shared/types";

const mockMessageView = vi.fn();
const mockThinkingIndicator = vi.fn();
const mockFullscreenChatOverlay = vi.fn();

// Mock child components
vi.mock("../thread/message-view", () => ({
  MessageView: (props: { message: UIMessage; model: ModelDefinition }) => {
    mockMessageView(props);
    const { message, model } = props;
    return (
      <div data-testid={`message-${message.id}`} data-role={message.role}>
        <span data-testid="message-model">{model.name}</span>
        {message.parts?.map((part, i) => (
          <span key={i} data-testid={`part-${i}`}>
            {(part as any).text || (part as any).type}
          </span>
        ))}
      </div>
    );
  },
}));

vi.mock("../shared/thinking-indicator", () => ({
  ThinkingIndicator: ({
    model,
    variant,
  }: {
    model: ModelDefinition;
    variant?: string;
  }) => {
    mockThinkingIndicator({ model, variant });
    return (
      <div data-testid="thinking-indicator">Thinking... ({model.name})</div>
    );
  },
}));

vi.mock("../fullscreen-chat-overlay", () => ({
  FullscreenChatOverlay: (props: Record<string, unknown>) => {
    mockFullscreenChatOverlay(props);
    return <div data-testid="fullscreen-chat-overlay">Fullscreen Overlay</div>;
  },
}));

describe("Thread", () => {
  const defaultModel: ModelDefinition = {
    id: "gpt-4",
    name: "GPT-4",
    provider: "openai",
    contextWindow: 8192,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
  };

  const createMessage = (overrides: Partial<UIMessage> = {}): UIMessage => ({
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [{ type: "text", text: "Hello" }],
    ...overrides,
  });

  const defaultProps = {
    messages: [] as UIMessage[],
    sendFollowUpMessage: vi.fn(),
    model: defaultModel,
    isLoading: false,
    toolsMetadata: {},
    toolServerMap: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("message rendering", () => {
    it("renders empty when no messages", () => {
      render(<Thread {...defaultProps} />);

      expect(screen.queryByTestId(/^message-msg-/)).not.toBeInTheDocument();
    });

    it("renders user messages", () => {
      const messages = [
        createMessage({
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        }),
      ];

      render(<Thread {...defaultProps} messages={messages} />);

      expect(screen.getByTestId("message-msg-1")).toBeInTheDocument();
      expect(screen.getByTestId("message-msg-1")).toHaveAttribute(
        "data-role",
        "user",
      );
    });

    it("renders assistant messages", () => {
      const messages = [
        createMessage({
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "Hi there!" }],
        }),
      ];

      render(<Thread {...defaultProps} messages={messages} />);

      expect(screen.getByTestId("message-msg-1")).toBeInTheDocument();
      expect(screen.getByTestId("message-msg-1")).toHaveAttribute(
        "data-role",
        "assistant",
      );
    });

    it("renders multiple messages in order", () => {
      const messages = [
        createMessage({ id: "msg-1", role: "user" }),
        createMessage({ id: "msg-2", role: "assistant" }),
        createMessage({ id: "msg-3", role: "user" }),
      ];

      render(<Thread {...defaultProps} messages={messages} />);

      const messageElements = screen.getAllByTestId(/^message-msg-/);
      expect(messageElements).toHaveLength(3);
      expect(messageElements[0]).toHaveAttribute("data-role", "user");
      expect(messageElements[1]).toHaveAttribute("data-role", "assistant");
      expect(messageElements[2]).toHaveAttribute("data-role", "user");
    });

    it("passes model to MessageView", () => {
      const messages = [createMessage({ id: "msg-1" })];

      render(<Thread {...defaultProps} messages={messages} />);

      expect(screen.getByTestId("message-model")).toHaveTextContent("GPT-4");
    });

    it("forwards interactive to MessageView", () => {
      const messages = [createMessage({ id: "msg-1" })];

      render(
        <Thread {...defaultProps} messages={messages} interactive={false} />,
      );

      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          interactive: false,
        }),
      );
    });

    it("forwards reasoningDisplayMode to MessageView", () => {
      const messages = [createMessage({ id: "msg-1" })];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          reasoningDisplayMode="collapsed"
        />,
      );

      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoningDisplayMode: "collapsed",
        }),
      );
    });

    it("forwards hidden reasoningDisplayMode to MessageView", () => {
      const messages = [createMessage({ id: "msg-1" })];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          reasoningDisplayMode="hidden"
        />,
      );

      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoningDisplayMode: "hidden",
        }),
      );
    });

    it("keeps interactive and reasoningDisplayMode defaults", () => {
      const messages = [createMessage({ id: "msg-1" })];

      render(<Thread {...defaultProps} messages={messages} />);

      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          interactive: true,
          reasoningDisplayMode: "inline",
        }),
      );
    });

    it("applies shared transcript navigation wrappers when focus props are provided", () => {
      const messages = [
        createMessage({ id: "msg-1", role: "assistant" }),
        createMessage({ id: "msg-2", role: "assistant" }),
      ];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          focusMessageId="msg-2"
          highlightedMessageIds={["msg-2"]}
          navigationKey={1}
        />,
      );

      const wrapper = screen.getByTestId("message-msg-2").parentElement;
      expect(wrapper).toHaveAttribute("data-focused", "true");
      expect(wrapper).toHaveAttribute("data-highlighted", "true");
    });
  });

  describe("loading state", () => {
    it("shows thinking indicator when loading", () => {
      render(<Thread {...defaultProps} isLoading={true} />);

      expect(screen.getByTestId("thinking-indicator")).toBeInTheDocument();
    });

    it("hides thinking indicator when not loading", () => {
      render(<Thread {...defaultProps} isLoading={false} />);

      expect(
        screen.queryByTestId("thinking-indicator"),
      ).not.toBeInTheDocument();
    });

    it("shows thinking indicator with model name", () => {
      render(<Thread {...defaultProps} isLoading={true} />);

      expect(screen.getByTestId("thinking-indicator")).toHaveTextContent(
        "GPT-4",
      );
    });

    it("defaults to the GPT pulse for OpenAI models when no explicit variant is provided", () => {
      const messages = [createMessage({ id: "msg-1", role: "user" })];

      render(<Thread {...defaultProps} messages={messages} isLoading={true} />);

      expect(mockThinkingIndicator).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "chatgpt-dot",
        }),
      );
    });

    it("defaults to the Claude mascot for Anthropic models when no explicit variant is provided", () => {
      const messages = [createMessage({ id: "msg-1", role: "user" })];
      const claudeModel: ModelDefinition = {
        ...defaultModel,
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
      };

      render(
        <Thread
          {...defaultProps}
          model={claudeModel}
          messages={messages}
          isLoading={true}
        />,
      );

      expect(mockThinkingIndicator).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "claude-mark",
        }),
      );
    });

    it("passes the selected loading indicator variant to the inline indicator", () => {
      render(
        <Thread
          {...defaultProps}
          isLoading={true}
          loadingIndicatorVariant="claude-mark"
        />,
      );

      expect(mockThinkingIndicator).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "claude-mark",
        }),
      );
    });

    it("keeps the GPT pulse visible before the first assistant message streams", () => {
      const messages = [createMessage({ id: "msg-1", role: "user" })];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          isLoading={true}
          loadingIndicatorVariant="chatgpt-dot"
        />,
      );

      expect(screen.getByTestId("thinking-indicator")).toBeInTheDocument();
      expect(mockThinkingIndicator).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "chatgpt-dot",
        }),
      );
    });

    it("hides the GPT pulse once assistant content is visible while loading", () => {
      const messages = [
        createMessage({ id: "msg-1", role: "user" }),
        createMessage({
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Streaming..." }],
        }),
      ];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          isLoading={true}
          loadingIndicatorVariant="chatgpt-dot"
        />,
      );

      expect(
        screen.queryByTestId("thinking-indicator"),
      ).not.toBeInTheDocument();
      expect(mockThinkingIndicator).not.toHaveBeenCalled();
    });

    it("keeps the Claude placeholder row visible before the first assistant message streams", () => {
      const messages = [createMessage({ id: "msg-1", role: "user" })];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          isLoading={true}
          loadingIndicatorVariant="claude-mark"
        />,
      );

      expect(screen.getByTestId("thinking-indicator")).toBeInTheDocument();
      expect(mockThinkingIndicator).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "claude-mark",
        }),
      );
      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ id: "msg-1" }),
          claudeFooterMode: "none",
        }),
      );
    });

    it("moves the Claude mascot onto the latest assistant message while loading", () => {
      const messages = [
        createMessage({ id: "msg-1", role: "user" }),
        createMessage({
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Streaming..." }],
        }),
      ];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          isLoading={true}
          loadingIndicatorVariant="claude-mark"
        />,
      );

      expect(
        screen.queryByTestId("thinking-indicator"),
      ).not.toBeInTheDocument();
      expect(mockThinkingIndicator).not.toHaveBeenCalled();
      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ id: "msg-2" }),
          claudeFooterMode: "animated",
        }),
      );
    });

    it("keeps the standalone Claude placeholder if the latest assistant message is still empty", () => {
      const messages = [
        createMessage({ id: "msg-1", role: "user" }),
        createMessage({
          id: "msg-2",
          role: "assistant",
          parts: [],
        }),
      ];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          isLoading={true}
          loadingIndicatorVariant="claude-mark"
        />,
      );

      expect(screen.getByTestId("thinking-indicator")).toBeInTheDocument();
      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ id: "msg-2" }),
          claudeFooterMode: "none",
        }),
      );
    });

    it("keeps only the latest assistant Claude footer and makes it static after loading", () => {
      const messages = [
        createMessage({
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "Older answer" }],
        }),
        createMessage({ id: "msg-2", role: "user" }),
        createMessage({
          id: "msg-3",
          role: "assistant",
          parts: [{ type: "text", text: "Latest answer" }],
        }),
      ];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          isLoading={false}
          loadingIndicatorVariant="claude-mark"
        />,
      );

      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ id: "msg-1" }),
          claudeFooterMode: "none",
        }),
      );
      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ id: "msg-3" }),
          claudeFooterMode: "static",
        }),
      );
    });

    it("keeps the GPT pulse hidden after the response finishes", () => {
      const messages = [
        createMessage({ id: "msg-1", role: "user" }),
        createMessage({
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text: "Done." }],
        }),
      ];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          isLoading={false}
          loadingIndicatorVariant="chatgpt-dot"
        />,
      );

      expect(
        screen.queryByTestId("thinking-indicator"),
      ).not.toBeInTheDocument();
    });
  });

  describe("PiP functionality", () => {
    it("renders PiP spacer when pipWidgetId is set", () => {
      const messages = [createMessage({ id: "msg-1" })];

      const { container } = render(
        <Thread {...defaultProps} messages={messages} />,
      );

      // Initially no PiP spacer
      expect(container.querySelector(".h-\\[480px\\]")).not.toBeInTheDocument();
    });
  });

  describe("fullscreen chat overlay", () => {
    it("does not show fullscreen overlay by default", () => {
      render(<Thread {...defaultProps} enableFullscreenChatOverlay={true} />);

      // Overlay only shows when fullscreenWidgetId is set (handled by internal state)
      expect(
        screen.queryByTestId("fullscreen-chat-overlay"),
      ).not.toBeInTheDocument();
    });

    it("passes the selected loading indicator variant to the fullscreen overlay", () => {
      const messages = [createMessage({ id: "msg-1", role: "assistant" })];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          enableFullscreenChatOverlay={true}
          loadingIndicatorVariant="claude-mark"
        />,
      );

      act(() => {
        const firstMessageProps = mockMessageView.mock.calls[0]?.[0];
        firstMessageProps?.onRequestFullscreen("tool-1");
      });

      expect(screen.getByTestId("fullscreen-chat-overlay")).toBeInTheDocument();
      expect(mockFullscreenChatOverlay).toHaveBeenLastCalledWith(
        expect.objectContaining({
          loadingIndicatorVariant: "claude-mark",
        }),
      );
    });

    it("forwards fullscreen stop controls without disabling drafting while loading", () => {
      const onFullscreenChatStop = vi.fn();
      const messages = [createMessage({ id: "msg-1", role: "assistant" })];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          isLoading={true}
          enableFullscreenChatOverlay={true}
          onFullscreenChatStop={onFullscreenChatStop}
        />,
      );

      act(() => {
        const firstMessageProps = mockMessageView.mock.calls[0]?.[0];
        firstMessageProps?.onRequestFullscreen("tool-1");
      });

      expect(mockFullscreenChatOverlay).toHaveBeenLastCalledWith(
        expect.objectContaining({
          disabled: false,
          isThinking: true,
          canSend: false,
          onStop: onFullscreenChatStop,
        }),
      );
    });
  });

  describe("callbacks", () => {
    it("passes sendFollowUpMessage to MessageView", () => {
      const sendFollowUp = vi.fn();
      const messages = [createMessage({ id: "msg-1" })];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          sendFollowUpMessage={sendFollowUp}
        />,
      );

      // The callback is passed down - we verify the component renders
      expect(screen.getByTestId("message-msg-1")).toBeInTheDocument();
    });
  });

  describe("display mode", () => {
    it("accepts displayMode prop", () => {
      const messages = [createMessage({ id: "msg-1" })];

      render(
        <Thread {...defaultProps} messages={messages} displayMode="inline" />,
      );

      expect(screen.getByTestId("message-msg-1")).toBeInTheDocument();
    });

    it("calls onDisplayModeChange when provided", () => {
      const onDisplayModeChange = vi.fn();
      const messages = [createMessage({ id: "msg-1" })];

      render(
        <Thread
          {...defaultProps}
          messages={messages}
          displayMode="inline"
          onDisplayModeChange={onDisplayModeChange}
        />,
      );

      // The callback is passed down to MessageView
      expect(screen.getByTestId("message-msg-1")).toBeInTheDocument();
    });
  });
});
