import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MessageView } from "../thread/message-view";
import type { UIMessage } from "@ai-sdk/react";
import type { ModelDefinition } from "@/shared/types";
import { ScenarioHostStyleProvider } from "@/contexts/scenario-client-style-context";
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

    it("shows the user timestamp in the hover action row", () => {
      const message = createMessage({
        role: "user",
        metadata: { timestampMs: 1_700_000_000_000 },
      });

      const { container } = renderMessageView(
        <MessageView {...defaultProps} message={message} />,
      );

      const time = container.querySelector("time");
      expect(time).not.toBeNull();
      expect(time).toHaveAttribute("dateTime");
      expect(time!.closest(".opacity-0")).not.toBeNull();
      expect(container.textContent).toContain(time!.textContent);
      expect(time!.parentElement?.firstElementChild).toBe(time);
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
        />,
      );

      expect(renderActions).toHaveBeenCalledTimes(1);
      expect(renderActions).toHaveBeenCalledWith(
        expect.objectContaining({ id: "msg-row-test" }),
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
        screen.queryByTestId("save-as-test-case-stub"),
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
        />,
      );
      expect(renderActions).not.toHaveBeenCalled();
      expect(
        screen.queryByTestId("save-as-test-case-stub"),
      ).not.toBeInTheDocument();
    });
  });

  describe("renderAssistantTurnFooter", () => {
    it("renders the footer under an assistant message", () => {
      const message = createMessage({
        id: "msg-assistant-rated",
        role: "assistant",
        parts: [{ type: "text", text: "assistant reply" }],
      });
      const renderFooter = vi.fn(() => (
        <div data-testid="turn-rating-stub">stars</div>
      ));

      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          renderAssistantTurnFooter={renderFooter}
        />,
      );

      expect(renderFooter).toHaveBeenCalledWith(
        expect.objectContaining({ id: "msg-assistant-rated" }),
      );
      expect(screen.getByTestId("turn-rating-stub")).toBeInTheDocument();
    });

    it("does not render the footer for user messages", () => {
      // The thing being rated is the RESPONSE; a rating widget under the
      // tester's own prompt has nothing to judge.
      const message = createMessage({
        role: "user",
        parts: [{ type: "text", text: "a prompt" }],
      });
      const renderFooter = vi.fn(() => (
        <div data-testid="turn-rating-stub">stars</div>
      ));

      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          renderAssistantTurnFooter={renderFooter}
        />,
      );

      expect(renderFooter).not.toHaveBeenCalled();
      expect(screen.queryByTestId("turn-rating-stub")).not.toBeInTheDocument();
    });

    it("renders the footer outside the hover-only copy actions", () => {
      // A rating prompt nobody can see until they hover is a rating nobody
      // leaves, so the footer must not inherit the `opacity-0` block.
      const message = createMessage({
        id: "msg-assistant-visible",
        role: "assistant",
        parts: [{ type: "text", text: "assistant reply" }],
      });

      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          renderAssistantTurnFooter={() => (
            <div data-testid="turn-rating-stub">stars</div>
          )}
        />,
      );

      const footer = screen.getByTestId("turn-rating-stub");
      expect(footer.closest(".opacity-0")).toBeNull();
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
        name: "Edit message",
      });

    it("renders the edit affordance only when a handler is provided", () => {
      const message = editableMessage();
      const { unmount } = renderMessageView(
        <MessageView {...defaultProps} message={message} />,
      );
      expect(
        screen.queryByRole("button", {
          name: "Edit message",
        }),
      ).not.toBeInTheDocument();
      unmount();

      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          onEditUserMessage={vi.fn()}
        />,
      );
      expect(editButton()).toBeInTheDocument();
      expect(editButton().querySelector(".lucide-pencil")).not.toBeNull();
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
        />,
      );
      expect(
        screen.queryByRole("button", {
          name: "Edit message",
        }),
      ).not.toBeInTheDocument();
    });

    it("swaps the bubble for a textarea seeded with the message text", () => {
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={editableMessage()}
          onEditUserMessage={vi.fn()}
        />,
      );

      fireEvent.click(editButton());

      const textarea = screen.getByRole("textbox", { name: "Edit message" });
      expect(textarea).toHaveValue("original prompt");
      expect(
        screen.queryByTestId("user-message-bubble"),
      ).not.toBeInTheDocument();
    });

    it("preserves every text part of a multi-part user message", () => {
      const onEditUserMessage = vi.fn();
      const message = createMessage({
        id: "msg-multi-part",
        role: "user",
        parts: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      });
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          onEditUserMessage={onEditUserMessage}
        />,
      );

      fireEvent.click(editButton());

      const textarea = screen.getByRole("textbox", { name: "Edit message" });
      // Both parts must be present, not just the first — extractUserMessageText
      // (used elsewhere for prompt previews) intentionally returns only the
      // first text part, but the editor has to round-trip every part or an
      // edit would silently discard the rest of the user's own message.
      expect(textarea).toHaveValue("Hello\n\nWorld");

      fireEvent.change(textarea, {
        target: { value: "Hello\n\nWorld and more" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(onEditUserMessage).toHaveBeenCalledTimes(1);
      expect(onEditUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "msg-multi-part" }),
        "Hello\n\nWorld and more",
      );
    });

    it("submits the edited text and closes the editor", async () => {
      const onEditUserMessage = vi.fn();
      const message = editableMessage();
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          onEditUserMessage={onEditUserMessage}
        />,
      );

      fireEvent.click(editButton());
      fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
        target: { value: "revised prompt" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(onEditUserMessage).toHaveBeenCalledTimes(1);
      expect(onEditUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "msg-edit-test" }),
        "revised prompt",
      );
      expect(
        await screen.findByTestId("user-message-bubble"),
      ).toBeInTheDocument();
    });

    // The host's gates run after awaits the editor cannot see (discard-draft
    // declined, server unreachable, thread switched, rewind refused). Closing
    // on dispatch rather than on click is what keeps the typed text alive:
    // `startEditing` reseeds from the message, so a closed editor is a lost
    // edit.
    it("keeps the editor and the typed text when the host refuses", async () => {
      const onEditUserMessage = vi.fn().mockResolvedValue(false);
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={editableMessage()}
          onEditUserMessage={onEditUserMessage}
        />,
      );

      fireEvent.click(editButton());
      fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
        target: { value: "a long carefully rewritten prompt" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Send" })).toBeEnabled(),
      );
      expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveValue(
        "a long carefully rewritten prompt",
      );
      expect(
        screen.queryByTestId("user-message-bubble"),
      ).not.toBeInTheDocument();
    });

    it("does not dispatch twice while the host is still deciding", async () => {
      let release: (value: boolean) => void = () => {};
      const onEditUserMessage = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      );
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={editableMessage()}
          onEditUserMessage={onEditUserMessage}
        />,
      );

      fireEvent.click(editButton());
      fireEvent.change(screen.getByRole("textbox", { name: "Edit message" }), {
        target: { value: "revised prompt" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(onEditUserMessage).toHaveBeenCalledTimes(1);
      release(true);
      expect(
        await screen.findByTestId("user-message-bubble"),
      ).toBeInTheDocument();
    });

    it("cancels without submitting and restores the bubble", () => {
      const onEditUserMessage = vi.fn();
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={editableMessage()}
          onEditUserMessage={onEditUserMessage}
        />,
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
        />,
      );

      fireEvent.click(editButton());
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(onEditUserMessage).not.toHaveBeenCalled();
      expect(screen.getByTestId("user-message-bubble")).toBeInTheDocument();
      expect(
        screen.queryByRole("textbox", { name: "Edit message" }),
      ).not.toBeInTheDocument();
    });

    it("submits on Enter without Shift", async () => {
      const onEditUserMessage = vi.fn();
      const message = editableMessage();
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={message}
          onEditUserMessage={onEditUserMessage}
        />,
      );

      fireEvent.click(editButton());
      const textarea = screen.getByRole("textbox", { name: "Edit message" });
      fireEvent.change(textarea, { target: { value: "revised via enter" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      expect(onEditUserMessage).toHaveBeenCalledTimes(1);
      expect(onEditUserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "msg-edit-test" }),
        "revised via enter",
      );
      expect(
        await screen.findByTestId("user-message-bubble"),
      ).toBeInTheDocument();
    });

    it("does not submit on Shift+Enter and keeps the editor open", () => {
      const onEditUserMessage = vi.fn();
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={editableMessage()}
          onEditUserMessage={onEditUserMessage}
        />,
      );

      fireEvent.click(editButton());
      const textarea = screen.getByRole("textbox", { name: "Edit message" });
      fireEvent.change(textarea, { target: { value: "line one\nline two" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

      expect(onEditUserMessage).not.toHaveBeenCalled();
      // The draft (including the newline already in it) survives untouched —
      // Shift+Enter must fall through to the textarea's own newline-insertion
      // behavior rather than the submit/cancel branches clearing anything.
      expect(textarea).toHaveValue("line one\nline two");
      expect(
        screen.queryByTestId("user-message-bubble"),
      ).not.toBeInTheDocument();
    });

    it("cancels via Escape and restores the bubble", () => {
      const onEditUserMessage = vi.fn();
      renderMessageView(
        <MessageView
          {...defaultProps}
          message={editableMessage()}
          onEditUserMessage={onEditUserMessage}
        />,
      );

      fireEvent.click(editButton());
      const textarea = screen.getByRole("textbox", { name: "Edit message" });
      fireEvent.change(textarea, { target: { value: "discarded via escape" } });
      fireEvent.keyDown(textarea, { key: "Escape" });

      expect(onEditUserMessage).not.toHaveBeenCalled();
      expect(screen.getByTestId("user-message-bubble")).toBeInTheDocument();
      expect(
        screen.queryByRole("textbox", { name: "Edit message" }),
      ).not.toBeInTheDocument();
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

    it("shows a timestamp for a tool-only assistant message", () => {
      const message = createMessage({
        role: "assistant",
        parts: [
          {
            type: "tool-example",
            toolCallId: "call-1",
            state: "output-available",
            input: {},
            output: {},
          } as any,
        ],
        metadata: { timestampMs: 1_700_000_000_000 },
      });

      const { container } = renderMessageView(
        <MessageView {...defaultProps} message={message} />,
      );

      const time = container.querySelector("time");
      expect(time).not.toBeNull();
      expect(time!.closest(".opacity-0")).not.toBeNull();
    });

    it("renders a completion timestamp added without changing message parts", () => {
      const parts = [{ type: "text", text: "done" }] as UIMessage["parts"];
      const message = createMessage({ role: "assistant", parts });
      const { container, rerender } = renderMessageView(
        <MessageView {...defaultProps} message={message} />,
      );

      expect(container.querySelector("time")).toBeNull();
      rerender(
        <PreferencesStoreProvider themeMode="light" themePreset="default">
          <MessageView
            {...defaultProps}
            message={{
              ...message,
              parts,
              metadata: { timestampMs: 1_700_000_000_000 },
            }}
          />
        </PreferencesStoreProvider>,
      );

      const time = container.querySelector("time");
      expect(time).not.toBeNull();
      expect(time!.parentElement?.lastElementChild).toBe(time);
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

    it("hides the leading assistant avatar in scenario host-style contexts", () => {
      const message = createMessage({
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
      });

      renderMessageView(
        <ScenarioHostStyleProvider value="claude">
          <MessageView {...defaultProps} message={message} />
        </ScenarioHostStyleProvider>,
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
