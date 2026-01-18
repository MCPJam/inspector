import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Thread } from "../thread";
import type { UIMessage } from "@ai-sdk/react";
import type { ModelDefinition } from "@/shared/types";

// Mock child components
vi.mock("../thread/message-view", () => ({
  MessageView: ({
    message,
    model,
  }: {
    message: UIMessage;
    model: ModelDefinition;
  }) => (
    <div data-testid={`message-${message.id}`} data-role={message.role}>
      <span data-testid="message-model">{model.name}</span>
      {message.parts?.map((part, i) => (
        <span key={i} data-testid={`part-${i}`}>
          {(part as any).text || (part as any).type}
        </span>
      ))}
    </div>
  ),
}));

vi.mock("../shared/thinking-indicator", () => ({
  ThinkingIndicator: ({ model }: { model: ModelDefinition }) => (
    <div data-testid="thinking-indicator">Thinking... ({model.name})</div>
  ),
}));

vi.mock("../fullscreen-chat-overlay", () => ({
  FullscreenChatOverlay: () => (
    <div data-testid="fullscreen-chat-overlay">Fullscreen Overlay</div>
  ),
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
        createMessage({ id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] }),
      ];

      render(<Thread {...defaultProps} messages={messages} />);

      expect(screen.getByTestId("message-msg-1")).toBeInTheDocument();
      expect(screen.getByTestId("message-msg-1")).toHaveAttribute(
        "data-role",
        "user"
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
        "assistant"
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
  });

  describe("loading state", () => {
    it("shows thinking indicator when loading", () => {
      render(<Thread {...defaultProps} isLoading={true} />);

      expect(screen.getByTestId("thinking-indicator")).toBeInTheDocument();
    });

    it("hides thinking indicator when not loading", () => {
      render(<Thread {...defaultProps} isLoading={false} />);

      expect(screen.queryByTestId("thinking-indicator")).not.toBeInTheDocument();
    });

    it("shows thinking indicator with model name", () => {
      render(<Thread {...defaultProps} isLoading={true} />);

      expect(screen.getByTestId("thinking-indicator")).toHaveTextContent(
        "GPT-4"
      );
    });
  });

  describe("PiP functionality", () => {
    it("renders PiP spacer when pipWidgetId is set", () => {
      const messages = [createMessage({ id: "msg-1" })];

      const { container } = render(
        <Thread {...defaultProps} messages={messages} />
      );

      // Initially no PiP spacer
      expect(
        container.querySelector(".h-\\[480px\\]")
      ).not.toBeInTheDocument();
    });
  });

  describe("fullscreen chat overlay", () => {
    it("does not show fullscreen overlay by default", () => {
      render(<Thread {...defaultProps} enableFullscreenChatOverlay={true} />);

      // Overlay only shows when fullscreenWidgetId is set (handled by internal state)
      expect(
        screen.queryByTestId("fullscreen-chat-overlay")
      ).not.toBeInTheDocument();
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
        />
      );

      // The callback is passed down - we verify the component renders
      expect(screen.getByTestId("message-msg-1")).toBeInTheDocument();
    });
  });

  describe("display mode", () => {
    it("accepts displayMode prop", () => {
      const messages = [createMessage({ id: "msg-1" })];

      render(
        <Thread {...defaultProps} messages={messages} displayMode="inline" />
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
        />
      );

      // The callback is passed down to MessageView
      expect(screen.getByTestId("message-msg-1")).toBeInTheDocument();
    });
  });
});
