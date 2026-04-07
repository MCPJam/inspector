import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MessageView } from "../thread/message-view";
import type { UIMessage } from "@ai-sdk/react";
import type { ModelDefinition } from "@/shared/types";
import { SandboxHostStyleProvider } from "@/contexts/sandbox-host-style-context";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";

// Mock PartSwitch
vi.mock("../thread/part-switch", () => ({
  PartSwitch: ({ part, role }: { part: any; role: string }) => (
    <div data-testid={`part-${part.type}`} data-role={role}>
      {part.text || part.type}
    </div>
  ),
}));

// Mock UserMessageBubble
vi.mock("../thread/user-message-bubble", () => ({
  UserMessageBubble: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="user-message-bubble">{children}</div>
  ),
}));

// Mock thread-helpers
vi.mock("../thread/thread-helpers", () => ({
  groupAssistantPartsIntoSteps: (parts: any[]) => [parts],
}));

describe("MessageView", () => {
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
    model: defaultModel,
    onSendFollowUp: vi.fn(),
    toolsMetadata: {},
    toolServerMap: {},
    pipWidgetId: null,
    fullscreenWidgetId: null,
    onRequestPip: vi.fn(),
    onExitPip: vi.fn(),
    onRequestFullscreen: vi.fn(),
    onExitFullscreen: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderMessageView = (ui: ReactElement) =>
    render(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        {ui}
      </PreferencesStoreProvider>,
    );

  describe("user messages", () => {
    it("renders user message in bubble", () => {
      const message = createMessage({
        role: "user",
        parts: [{ type: "text", text: "Hello world" }],
      });

      renderMessageView(<MessageView {...defaultProps} message={message} />);

      expect(screen.getByTestId("user-message-bubble")).toBeInTheDocument();
    });

    it("renders text parts for user message", () => {
      const message = createMessage({
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      });

      renderMessageView(<MessageView {...defaultProps} message={message} />);

      expect(screen.getByTestId("part-text")).toBeInTheDocument();
      expect(screen.getByTestId("part-text")).toHaveAttribute(
        "data-role",
        "user",
      );
    });

    it("renders multiple parts for user message", () => {
      const message = createMessage({
        role: "user",
        parts: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      });

      renderMessageView(<MessageView {...defaultProps} message={message} />);

      const textParts = screen.getAllByTestId("part-text");
      expect(textParts).toHaveLength(2);
    });
  });

  describe("assistant messages", () => {
    it("renders assistant message without bubble", () => {
      const message = createMessage({
        role: "assistant",
        parts: [{ type: "text", text: "Hi there!" }],
      });

      renderMessageView(<MessageView {...defaultProps} message={message} />);

      expect(
        screen.queryByTestId("user-message-bubble"),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("article")).toBeInTheDocument();
    });

    it("renders text parts for assistant message", () => {
      const message = createMessage({
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
      });

      renderMessageView(<MessageView {...defaultProps} message={message} />);

      expect(screen.getByTestId("part-text")).toBeInTheDocument();
      expect(screen.getByTestId("part-text")).toHaveAttribute(
        "data-role",
        "assistant",
      );
    });

    it("renders a leading assistant avatar outside host-style contexts", () => {
      const message = createMessage({
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
      });

      renderMessageView(<MessageView {...defaultProps} message={message} />);

      expect(screen.getByRole("img")).toBeInTheDocument();
      expect(screen.getByLabelText("GPT-4 assistant")).toBeInTheDocument();
    });

    it("hides the leading assistant avatar in sandbox host-style contexts", () => {
      const message = createMessage({
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
      });

      renderMessageView(
        <SandboxHostStyleProvider value="claude">
          <MessageView {...defaultProps} message={message} />
        </SandboxHostStyleProvider>,
      );

      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText("GPT-4 assistant"),
      ).not.toBeInTheDocument();
    });
  });

  describe("special messages", () => {
    it("hides widget-state messages", () => {
      const message = createMessage({
        id: "widget-state-123",
        role: "user",
        parts: [{ type: "text", text: "Widget state" }],
      });

      const { container } = renderMessageView(
        <MessageView {...defaultProps} message={message} />,
      );

      expect(container.firstChild).toBeNull();
    });

    it("hides model-context messages", () => {
      const message = createMessage({
        id: "model-context-123",
        role: "user",
        parts: [{ type: "text", text: "Model context" }],
      });

      const { container } = renderMessageView(
        <MessageView {...defaultProps} message={message} />,
      );

      expect(container.firstChild).toBeNull();
    });

    it("returns null for non-user/assistant roles", () => {
      const message = createMessage({
        role: "system" as any,
        parts: [{ type: "text", text: "System message" }],
      });

      const { container } = renderMessageView(
        <MessageView {...defaultProps} message={message} />,
      );

      expect(container.firstChild).toBeNull();
    });
  });

  describe("message parts", () => {
    it("passes parts to PartSwitch", () => {
      const message = createMessage({
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      });

      renderMessageView(<MessageView {...defaultProps} message={message} />);

      expect(screen.getByTestId("part-text")).toHaveTextContent("Hello");
    });

    it("handles empty parts array", () => {
      const message = createMessage({
        role: "user",
        parts: [],
      });

      renderMessageView(<MessageView {...defaultProps} message={message} />);

      expect(screen.getByTestId("user-message-bubble")).toBeInTheDocument();
    });

    it("handles undefined parts", () => {
      const message = createMessage({
        role: "user",
        parts: undefined,
      });

      renderMessageView(<MessageView {...defaultProps} message={message} />);

      expect(screen.getByTestId("user-message-bubble")).toBeInTheDocument();
    });
  });

  describe("callbacks", () => {
    it("passes onSendFollowUp to PartSwitch", () => {
      const onSendFollowUp = vi.fn();
      const message = createMessage({
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      });

      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          onSendFollowUp={onSendFollowUp}
        />,
      );

      expect(screen.getByTestId("part-text")).toBeInTheDocument();
    });

    it("passes widget state handlers to PartSwitch", () => {
      const onWidgetStateChange = vi.fn();
      const message = createMessage({
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      });

      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          onWidgetStateChange={onWidgetStateChange}
        />,
      );

      expect(screen.getByTestId("part-text")).toBeInTheDocument();
    });
  });

  describe("display mode", () => {
    it("passes displayMode to PartSwitch", () => {
      const message = createMessage({
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      });

      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          displayMode="fullscreen"
        />,
      );

      expect(screen.getByTestId("part-text")).toBeInTheDocument();
    });
  });
});
