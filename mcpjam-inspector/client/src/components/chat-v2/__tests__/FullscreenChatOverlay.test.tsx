import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import type { UIMessage } from "@ai-sdk/react";

import {
  SandboxHostStyleProvider,
  SandboxHostThemeProvider,
} from "@/contexts/sandbox-host-style-context";
import { FullscreenChatOverlay } from "../fullscreen-chat-overlay";

vi.mock("../shared/loading-indicator-content", () => ({
  LoadingIndicatorContent: ({ variant }: { variant?: string }) => (
    <div data-testid={`loading-indicator-${variant ?? "default"}`} />
  ),
  useResolvedLoadingIndicatorVariant: (variant?: string) =>
    variant ?? "default",
}));

vi.mock("../shared/claude-loading-indicator", () => ({
  ClaudeLoadingIndicator: ({ mode = "animated" }: { mode?: string }) => (
    <div data-testid={`claude-indicator-${mode}`} />
  ),
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
      <SandboxHostStyleProvider value={hostStyle}>
        <SandboxHostThemeProvider value={theme}>{ui}</SandboxHostThemeProvider>
      </SandboxHostStyleProvider>,
    );

  it("shows a standalone Claude placeholder row before the first assistant token appears", () => {
    render(
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[createMessage({ id: "msg-1", role: "user" })]}
        isThinking={true}
        loadingIndicatorVariant="claude-mark"
      />,
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
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[createMessage({ id: "msg-1", role: "user" })]}
        isThinking={true}
        loadingIndicatorVariant="chatgpt-dot"
      />,
    );

    expect(screen.getByTestId("fullscreen-thinking-row")).toBeInTheDocument();
    expect(
      screen.getByTestId("loading-indicator-chatgpt-dot"),
    ).toBeInTheDocument();
  });

  it("hides the GPT pulse once assistant preview text is visible while streaming", () => {
    render(
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
        loadingIndicatorVariant="chatgpt-dot"
      />,
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
        loadingIndicatorVariant="chatgpt-dot"
      />,
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
        loadingIndicatorVariant="claude-mark"
      />,
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
        loadingIndicatorVariant="claude-mark"
      />,
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
      "sandbox-host-composer",
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
      "sandbox-host-composer",
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
      "sandbox-host-composer",
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
      "sandbox-host-composer",
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
