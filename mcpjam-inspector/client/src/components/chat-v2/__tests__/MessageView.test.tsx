import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MessageView } from "../thread/message-view";
import type { UIMessage } from "@ai-sdk/react";
import type { ModelDefinition } from "@/shared/types";
import { ChatboxHostStyleProvider } from "@/contexts/chatbox-client-style-context";
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
  isHiddenInternalMessage: (message: { id?: string }) =>
    message.id?.startsWith("widget-state-") === true ||
    message.id?.startsWith("model-context-") === true,
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
      </PreferencesStoreProvider>
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
        "user"
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

    it("renders renderUserMessageActions slot below the bubble when provided", () => {
      const message = createMessage({
        id: "msg-row-test",
        role: "user",
        parts: [{ type: "text", text: "Save me" }],
      });
      const renderActions = vi.fn(() => (
        <button data-testid="save-as-test-case-stub">save</button>
      ));

      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          renderUserMessageActions={renderActions}
        />
      );

      expect(renderActions).toHaveBeenCalledTimes(1);
      expect(renderActions).toHaveBeenCalledWith(
        expect.objectContaining({ id: "msg-row-test" })
      );
      expect(screen.getByTestId("save-as-test-case-stub")).toBeInTheDocument();
    });

    it("does not render the actions slot when no renderer is provided", () => {
      const message = createMessage({
        role: "user",
        parts: [{ type: "text", text: "no actions" }],
      });
      renderMessageView(<MessageView {...defaultProps} message={message} />);
      expect(
        screen.queryByTestId("save-as-test-case-stub")
      ).not.toBeInTheDocument();
    });

    it("does not render the actions slot for assistant messages", () => {
      const message = createMessage({
        role: "assistant",
        parts: [{ type: "text", text: "assistant reply" }],
      });
      const renderActions = vi.fn(() => (
        <button data-testid="save-as-test-case-stub">save</button>
      ));
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          renderUserMessageActions={renderActions}
        />
      );
      expect(renderActions).not.toHaveBeenCalled();
      expect(
        screen.queryByTestId("save-as-test-case-stub")
      ).not.toBeInTheDocument();
    });
  });

  describe("editing a past user message", () => {
    const editableMessage = () =>
      createMessage({
        id: "msg-edit-test",
        role: "user",
        parts: [{ type: "text", text: "original prompt" }],
      });

    const editButton = () =>
      screen.getByRole("button", {
        name: "Edit this message and branch the thread",
      });

    it("renders the edit affordance only when a handler is provided", () => {
      const message = editableMessage();
      const { unmount } = renderMessageView(
        <MessageView {...defaultProps} message={message} />
      );
      expect(
        screen.queryByRole("button", {
          name: "Edit this message and branch the thread",
        })
      ).not.toBeInTheDocument();
      unmount();

      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          onEditUserMessage={vi.fn()}
        />
      );
      expect(editButton()).toBeInTheDocument();
    });

    it("does not render the edit affordance for assistant messages", () => {
      const message = createMessage({
        role: "assistant",
        parts: [{ type: "text", text: "assistant reply" }],
      });
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          onEditUserMessage={vi.fn()}
        />
      );
      expect(
        screen.queryByRole("button", {
          name: "Edit this message and branch the thread",
        })
      ).not.toBeInTheDocument();
    });

    it("swaps the bubble for a textarea seeded with the message text", () => {
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={editableMessage()}
          onEditUserMessage={vi.fn()}
        />
      );

      fireEvent.click(editButton());

      const textarea = screen.getByRole("textbox", { name: "Edit message" });
      expect(textarea).toHaveValue("original prompt");
      expect(
        screen.queryByTestId("user-message-bubble")
      ).not.toBeInTheDocument();
    });

    it("submits the edited text and closes the editor", () => {
      const onEditUserMessage = vi.fn();
      const message = editableMessage();
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          onEditUserMessage={onEditUserMessage}
        />
      );

      fireEvent.click(editButton());
      fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
        target: { value: "revised prompt" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(onEditUserMessage).toHaveBeenCalledTimes(1);
      expect(onEditUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "msg-edit-test" }),
        "revised prompt"
      );
      expect(screen.getByTestId("user-message-bubble")).toBeInTheDocument();
    });

    it("cancels without submitting and restores the bubble", () => {
      const onEditUserMessage = vi.fn();
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={editableMessage()}
          onEditUserMessage={onEditUserMessage}
        />
      );

      fireEvent.click(editButton());
      fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
        target: { value: "discarded" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onEditUserMessage).not.toHaveBeenCalled();
      expect(screen.getByTestId("user-message-bubble")).toBeInTheDocument();
    });

    it("does not resend when the text is unchanged", () => {
      const onEditUserMessage = vi.fn();
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={editableMessage()}
          onEditUserMessage={onEditUserMessage}
        />
      );

      fireEvent.click(editButton());
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(onEditUserMessage).not.toHaveBeenCalled();
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
        screen.queryByTestId("user-message-bubble")
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
        "assistant"
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

    it("hides the leading assistant avatar in chatbox host-style contexts", () => {
      const message = createMessage({
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
      });

      renderMessageView(
        <ChatboxHostStyleProvider value="claude">
          <MessageView {...defaultProps} message={message} />
        </ChatboxHostStyleProvider>
      );

      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText("GPT-4 assistant")
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
        <MessageView {...defaultProps} message={message} />
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
        <MessageView {...defaultProps} message={message} />
      );

      expect(container.firstChild).toBeNull();
    });

    it("returns null for non-user/assistant roles", () => {
      const message = createMessage({
        role: "system" as any,
        parts: [{ type: "text", text: "System message" }],
      });

      const { container } = renderMessageView(
        <MessageView {...defaultProps} message={message} />
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
        />
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
        />
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
        />
      );

      expect(screen.getByTestId("part-text")).toBeInTheDocument();
    });
  });
});
