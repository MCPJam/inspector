import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import type { UIMessage } from "@ai-sdk/react";

import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-client-style-context";
import { FullscreenChatOverlay } from "../fullscreen-chat-overlay";

// Mock loading-indicator-content so the test can assert which brand path
// LoadingIndicatorContent took without depending on the registry's actual
// indicator markup. The mock renders the host-style id from context (via a
// shared helper) or falls back to "default".
vi.mock("../shared/loading-indicator-content", async () => {
  const { useChatboxHostStyle } = await import(
    "@/contexts/chatbox-client-style-context"
  );
  return {
    LoadingIndicatorContent: ({
      modelProvider,
    }: {
      className?: string;
      modelProvider?: string | null;
    }) => {
      const hostStyle = useChatboxHostStyle();
      let resolved: string | null = hostStyle;
      if (!resolved && modelProvider) {
        const normalized = modelProvider.toLowerCase();
        if (normalized === "openai") resolved = "chatgpt";
        else if (normalized === "anthropic") resolved = "claude";
      }
      const variant =
        resolved === "claude"
          ? "claude-mark"
          : resolved === "chatgpt"
            ? "chatgpt-dot"
            : "default";
      return <div data-testid={`loading-indicator-${variant}`} />;
    },
    useResolvedHostStyleForIndicator: (modelProvider?: string | null) => {
      const hostStyle = useChatboxHostStyle();
      if (hostStyle) return hostStyle;
      if (!modelProvider) return null;
      const normalized = modelProvider.toLowerCase();
      if (normalized === "openai") return "chatgpt";
      if (normalized === "anthropic") return "claude";
      return null;
    },
  };
});

vi.mock("@/lib/client-styles/indicators/claude-mark", () => ({
  ClaudeLoadingIndicator: ({ mode = "animated" }: { mode?: string }) => (
    <div data-testid={`claude-indicator-${mode}`} />
  ),
  ClaudeMarkIndicator: () => <div data-testid="claude-indicator-animated" />,
}));

describe("FullscreenChatOverlay", () => {
  const createMessage = (overrides: Partial<UIMessage> = {}): UIMessage => ({
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [{ type: "text", text: "Hello" }],
    ...overrides,
  });

  const defaultProps = {
    messages: [] as UIMessage[],
    open: true,
    onOpenChange: vi.fn(),
    input: "",
    onInputChange: vi.fn(),
    placeholder: "Message…",
    disabled: false,
    canSend: false,
    isThinking: false,
    onStop: vi.fn(),
    onSend: vi.fn(),
  };

  const renderWithHostStyle = (
    hostStyle: "chatgpt" | "claude",
    theme: "light" | "dark",
    ui: ReactElement,
  ) =>
    render(
      <ChatboxHostStyleProvider value={hostStyle}>
        <ChatboxHostThemeProvider value={theme}>{ui}</ChatboxHostThemeProvider>
      </ChatboxHostStyleProvider>,
    );

  it("shows a standalone Claude placeholder row before the first assistant token appears", () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[createMessage({ id: "msg-1", role: "user" })]}
          isThinking={true}
        />
      </ChatboxHostStyleProvider>,
    );

    expect(screen.getByTestId("fullscreen-thinking-row")).toBeInTheDocument();
    expect(
      screen.getByTestId("loading-indicator-claude-mark"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("fullscreen-claude-footer-animated"),
    ).not.toBeInTheDocument();
  });

  it("shows a standalone GPT pulse before the first assistant token appears", () => {
    render(
      <ChatboxHostStyleProvider value="chatgpt">
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[createMessage({ id: "msg-1", role: "user" })]}
          isThinking={true}
        />
      </ChatboxHostStyleProvider>,
    );

    expect(screen.getByTestId("fullscreen-thinking-row")).toBeInTheDocument();
    expect(
      screen.getByTestId("loading-indicator-chatgpt-dot"),
    ).toBeInTheDocument();
  });

  it("hides the GPT pulse once assistant preview text is visible while streaming", () => {
    render(
      <ChatboxHostStyleProvider value="chatgpt">
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[
            createMessage({ id: "msg-1", role: "user" }),
            createMessage({
              id: "msg-2",
              role: "assistant",
              parts: [{ type: "text", text: "Streaming..." }],
            }),
          ]}
          isThinking={true}
        />
      </ChatboxHostStyleProvider>,
    );

    expect(
      screen.queryByTestId("fullscreen-thinking-row"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loading-indicator-chatgpt-dot"),
    ).not.toBeInTheDocument();
  });

  it("keeps the GPT pulse hidden after the response finishes", () => {
    render(
      <ChatboxHostStyleProvider value="chatgpt">
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[
            createMessage({ id: "msg-1", role: "user" }),
            createMessage({
              id: "msg-2",
              role: "assistant",
              parts: [{ type: "text", text: "Done." }],
            }),
          ]}
          isThinking={false}
        />
      </ChatboxHostStyleProvider>,
    );

    expect(
      screen.queryByTestId("fullscreen-thinking-row"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loading-indicator-chatgpt-dot"),
    ).not.toBeInTheDocument();
  });

  it("moves the Claude mascot onto the latest assistant bubble while streaming", () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[
            createMessage({ id: "msg-1", role: "user" }),
            createMessage({
              id: "msg-2",
              role: "assistant",
              parts: [{ type: "text", text: "Streaming..." }],
            }),
          ]}
          isThinking={true}
        />
      </ChatboxHostStyleProvider>,
    );

    expect(
      screen.queryByTestId("fullscreen-thinking-row"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("fullscreen-claude-footer-animated"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("claude-indicator-animated")).toBeInTheDocument();
  });

  it("keeps only one static Claude footer on the latest assistant bubble after loading", () => {
    render(
      <ChatboxHostStyleProvider value="claude">
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[
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
          ]}
          isThinking={false}
        />
      </ChatboxHostStyleProvider>,
    );

    expect(
      screen.queryByTestId("fullscreen-thinking-row"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("fullscreen-claude-footer-static"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId(/fullscreen-claude-footer-/)).toHaveLength(1);
    expect(screen.getByTestId("claude-indicator-static")).toBeInTheDocument();
  });

  it("uses Claude host shell colors in the fullscreen overlay", () => {
    renderWithHostStyle(
      "claude",
      "light",
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[createMessage({ id: "msg-1", role: "user" })]}
        input="Follow up"
        canSend={true}
      />,
    );

    expect(screen.getByTestId("fullscreen-composer")).toHaveClass(
      "chatbox-host-composer",
    );
    expect(screen.getByTestId("fullscreen-composer")).toHaveStyle(
      "background-color: rgba(249, 247, 243, 1)",
    );
  });

  it("uses Claude dark host thread colors on the fullscreen composer", () => {
    renderWithHostStyle(
      "claude",
      "dark",
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[createMessage({ id: "msg-1", role: "user" })]}
        input="Follow up"
        canSend={true}
      />,
    );

    expect(screen.getByTestId("fullscreen-composer")).toHaveClass(
      "chatbox-host-composer",
    );
    expect(screen.getByTestId("fullscreen-composer")).toHaveStyle(
      "background-color: rgba(38, 38, 36, 1)",
    );
  });

  it("uses ChatGPT light host thread colors on the fullscreen composer", () => {
    renderWithHostStyle(
      "chatgpt",
      "light",
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[createMessage({ id: "msg-1", role: "user" })]}
        input="Follow up"
        canSend={true}
      />,
    );

    expect(screen.getByTestId("fullscreen-composer")).toHaveClass(
      "chatbox-host-composer",
    );
    expect(screen.getByTestId("fullscreen-composer")).toHaveStyle(
      "background-color: rgba(255, 255, 255, 1)",
    );
  });

  it("uses ChatGPT dark host thread colors on the fullscreen composer", () => {
    renderWithHostStyle(
      "chatgpt",
      "dark",
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[createMessage({ id: "msg-1", role: "user" })]}
        input="Follow up"
        canSend={true}
      />,
    );

    expect(screen.getByTestId("fullscreen-composer")).toHaveClass(
      "chatbox-host-composer",
    );
    expect(screen.getByTestId("fullscreen-composer")).toHaveStyle(
      "background-color: rgba(33, 33, 33, 1)",
    );
  });

  it("keeps the default fullscreen composer styling when no host style is active", () => {
    render(
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[createMessage({ id: "msg-1", role: "user" })]}
        input="Follow up"
        canSend={true}
      />,
    );

    expect(screen.getByTestId("fullscreen-composer")).toHaveClass(
      "rounded-full",
      "bg-background/95",
    );
  });

  it("keeps the fullscreen textarea editable while thinking", () => {
    render(
      <FullscreenChatOverlay
        {...defaultProps}
        input="Draft while thinking"
        isThinking={true}
      />,
    );

    expect(screen.getByPlaceholderText("Message…")).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Stop generating" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send message" }),
    ).not.toBeInTheDocument();
  });

  it("calls onStop from the fullscreen composer while thinking", () => {
    const onStop = vi.fn();

    render(
      <FullscreenChatOverlay
        {...defaultProps}
        input="Draft while thinking"
        isThinking={true}
        onStop={onStop}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("preserves the draft and re-enables send after thinking stops", () => {
    const { rerender } = render(
      <FullscreenChatOverlay
        {...defaultProps}
        input="Draft while thinking"
        isThinking={true}
      />,
    );

    expect(screen.getByPlaceholderText("Message…")).toHaveValue(
      "Draft while thinking",
    );

    rerender(
      <FullscreenChatOverlay
        {...defaultProps}
        input="Draft while thinking"
        canSend={true}
        isThinking={false}
      />,
    );

    expect(screen.getByPlaceholderText("Message…")).toHaveValue(
      "Draft while thinking",
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });
});
