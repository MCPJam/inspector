import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import type { UIMessage } from "@ai-sdk/react";

import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-client-style-context";
import {
  useAppToolInvocationLog,
  useAppToolsRegistry,
} from "@/components/chat-v2/thread/mcp-apps/app-tools-registry";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { FullscreenChatOverlay } from "../fullscreen-chat-overlay";

// Mock loading-indicator-content so the test can assert which brand path
// LoadingIndicatorContent took without depending on the registry's actual
// indicator markup. The mock renders the host-style id from context (via a
// shared helper) or falls back to "default".
vi.mock("../shared/loading-indicator-content", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../shared/loading-indicator-content")
    >();
  const { useChatboxHostStyle } = await import(
    "@/contexts/chatbox-client-style-context"
  );
  return {
    ...actual,
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
  beforeEach(() => {
    useAppToolsRegistry.setState({
      activeBridgeByParent: new Map(),
      aliases: new Map(),
      instancesByBridgeId: new Map(),
      pendingControllers: new Map(),
    });
    useAppToolInvocationLog.getState().clear();
  });

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

  const renderWithProviders = (ui: ReactElement) =>
    render(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        {ui}
      </PreferencesStoreProvider>
    );

  const renderWithHostStyle = (
    hostStyle: "chatgpt" | "claude",
    theme: "light" | "dark",
    ui: ReactElement
  ) =>
    renderWithProviders(
      <ChatboxHostStyleProvider value={hostStyle}>
        <ChatboxHostThemeProvider value={theme}>{ui}</ChatboxHostThemeProvider>
      </ChatboxHostStyleProvider>
    );

  it("shows a standalone Claude placeholder row before the first assistant token appears", () => {
    renderWithProviders(
      <ChatboxHostStyleProvider value="claude">
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[createMessage({ id: "msg-1", role: "user" })]}
          isThinking={true}
        />
      </ChatboxHostStyleProvider>
    );

    expect(screen.getByTestId("fullscreen-thinking-row")).toBeInTheDocument();
    expect(
      screen.getByTestId("loading-indicator-claude-mark")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("fullscreen-claude-footer-animated")
    ).not.toBeInTheDocument();
  });

  it("shows a standalone GPT pulse before the first assistant token appears", () => {
    renderWithProviders(
      <ChatboxHostStyleProvider value="chatgpt">
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[createMessage({ id: "msg-1", role: "user" })]}
          isThinking={true}
        />
      </ChatboxHostStyleProvider>
    );

    expect(screen.getByTestId("fullscreen-thinking-row")).toBeInTheDocument();
    expect(
      screen.getByTestId("loading-indicator-chatgpt-dot")
    ).toBeInTheDocument();
  });

  it("hides the GPT pulse once assistant preview text is visible while streaming", () => {
    renderWithProviders(
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
      </ChatboxHostStyleProvider>
    );

    expect(
      screen.queryByTestId("fullscreen-thinking-row")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loading-indicator-chatgpt-dot")
    ).not.toBeInTheDocument();
  });

  it("keeps tool-only assistant activity visible while streaming", () => {
    renderWithProviders(
      <ChatboxHostStyleProvider value="chatgpt">
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[
            createMessage({ id: "msg-1", role: "user" }),
            createMessage({
              id: "msg-2",
              role: "assistant",
              parts: [
                {
                  type: "dynamic-tool",
                  toolName: "search_docs",
                  toolCallId: "tool-1",
                  state: "input-streaming",
                  input: {},
                } as any,
              ],
            }),
          ]}
          isThinking={true}
        />
      </ChatboxHostStyleProvider>
    );

    expect(screen.getByText("search_docs")).toBeInTheDocument();
    expect(screen.getByTitle("Input streaming")).toBeInTheDocument();
    expect(
      screen.queryByTestId("fullscreen-thinking-row")
    ).not.toBeInTheDocument();
  });

  it("renders assistant markdown like thread text parts", () => {
    renderWithProviders(
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[
          createMessage({ id: "msg-1", role: "user" }),
          createMessage({
            id: "msg-2",
            role: "assistant",
            parts: [{ type: "text", text: "Invoked `start_game`" }],
          }),
        ]}
      />
    );

    expect(screen.getByText("start_game")).toBeInTheDocument();
    expect(screen.queryByText(/`start_game`/)).not.toBeInTheDocument();
  });

  it("keeps tool-only assistant output details collapsed until expanded", () => {
    renderWithProviders(
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[
          createMessage({ id: "msg-1", role: "user" }),
          createMessage({
            id: "msg-2",
            role: "assistant",
            parts: [
              {
                type: "dynamic-tool",
                toolName: "search_docs",
                toolCallId: "tool-1",
                state: "output-available",
                input: {},
                output: {
                  content: [{ type: "text", text: "Found the matching doc." }],
                },
              } as any,
            ],
          }),
        ]}
      />
    );

    expect(screen.getByText("search_docs")).toBeInTheDocument();
    expect(screen.queryByText("Result")).not.toBeInTheDocument();

    const toolHeader = screen.getByText("search_docs").closest('[role="button"]');
    expect(toolHeader).not.toBeNull();
    fireEvent.click(toolHeader!);

    expect(screen.getByText("Result")).toBeInTheDocument();
  });

  it("keeps assistant content visible when a tool part is added to the same message", () => {
    renderWithProviders(
      <ChatboxHostStyleProvider value="claude">
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[
            createMessage({ id: "msg-1", role: "user" }),
            createMessage({
              id: "msg-2",
              role: "assistant",
              content: "Let me check the board state." as any,
              parts: [
                {
                  type: "dynamic-tool",
                  toolName: "make_move",
                  toolCallId: "tool-1",
                  state: "output-available",
                  input: {},
                } as any,
              ],
            } as Partial<UIMessage>),
          ]}
          isThinking={true}
        />
      </ChatboxHostStyleProvider>
    );

    expect(
      screen.getByText("Let me check the board state.")
    ).toBeInTheDocument();
    expect(screen.getByText("make_move")).toBeInTheDocument();
    expect(screen.queryByText("Used make_move")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("fullscreen-thinking-row")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("fullscreen-claude-footer-animated")
    ).toBeInTheDocument();
  });

  it("resolves app-provided tool aliases in fullscreen tool cards", () => {
    useAppToolsRegistry.setState({
      activeBridgeByParent: new Map([["parent-1", "bridge-1"]]),
      aliases: new Map([
        [
          "app_951c1f5d",
          {
            alias: "app_951c1f5d",
            bridgeId: "bridge-1",
            rawName: "move_piece",
            readOnly: false,
          },
        ],
      ]),
      instancesByBridgeId: new Map([
        [
          "bridge-1",
          {
            appName: "Chess",
            bridge: {} as any,
            bridgeId: "bridge-1",
            parentToolCallId: "parent-1",
            registeredAtMs: Date.now(),
            serverId: "server-1",
            surface: "inline",
            tools: [],
          },
        ],
      ]),
      pendingControllers: new Map(),
    });

    renderWithProviders(
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[
          createMessage({ id: "msg-1", role: "user" }),
          createMessage({
            id: "msg-2",
            role: "assistant",
            parts: [
              {
                type: "dynamic-tool",
                toolName: "app_951c1f5d",
                toolCallId: "tool-1",
                state: "output-available",
                input: {},
              } as any,
            ],
          }),
        ]}
      />
    );

    expect(screen.getByText("move_piece")).toBeInTheDocument();
    expect(screen.getByText("from Chess")).toBeInTheDocument();
    expect(screen.queryByText(/app_951c1f5d/)).not.toBeInTheDocument();
  });

  it("keeps the GPT pulse hidden after the response finishes", () => {
    renderWithProviders(
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
      </ChatboxHostStyleProvider>
    );

    expect(
      screen.queryByTestId("fullscreen-thinking-row")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loading-indicator-chatgpt-dot")
    ).not.toBeInTheDocument();
  });

  it("keeps autoscrolling as the latest assistant text grows", () => {
    const hadScrollIntoView = "scrollIntoView" in Element.prototype;
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const userMessage = createMessage({ id: "msg-1", role: "user" });
      const assistantMessage = (text: string) =>
        createMessage({
          id: "msg-2",
          role: "assistant",
          parts: [{ type: "text", text }],
        });

      const { rerender } = renderWithProviders(
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[userMessage, assistantMessage("First chunk")]}
          isThinking={true}
        />
      );

      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      rerender(
        <FullscreenChatOverlay
          {...defaultProps}
          messages={[
            userMessage,
            assistantMessage("First chunk\nMore streamed content"),
          ]}
          isThinking={true}
        />
      );

      expect(scrollIntoView).toHaveBeenCalledTimes(2);
    } finally {
      if (hadScrollIntoView) {
        Object.defineProperty(Element.prototype, "scrollIntoView", {
          configurable: true,
          value: originalScrollIntoView,
        });
      } else {
        delete (Element.prototype as Partial<Element>).scrollIntoView;
      }
    }
  });

  it("moves the Claude mascot onto the latest assistant bubble while streaming", () => {
    renderWithProviders(
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
      </ChatboxHostStyleProvider>
    );

    expect(
      screen.queryByTestId("fullscreen-thinking-row")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("fullscreen-claude-footer-animated")
    ).toBeInTheDocument();
    expect(screen.getByTestId("claude-indicator-animated")).toBeInTheDocument();
  });

  it("keeps only one static Claude footer on the latest assistant bubble after loading", () => {
    renderWithProviders(
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
      </ChatboxHostStyleProvider>
    );

    expect(
      screen.queryByTestId("fullscreen-thinking-row")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("fullscreen-claude-footer-static")
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
      />
    );

    expect(screen.getByTestId("fullscreen-composer")).toHaveClass(
      "chatbox-host-composer"
    );
    expect(screen.getByTestId("fullscreen-composer")).toHaveStyle(
      "background-color: rgba(249, 247, 243, 1)"
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
      />
    );

    expect(screen.getByTestId("fullscreen-composer")).toHaveClass(
      "chatbox-host-composer"
    );
    expect(screen.getByTestId("fullscreen-composer")).toHaveStyle(
      "background-color: rgba(38, 38, 36, 1)"
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
      />
    );

    expect(screen.getByTestId("fullscreen-composer")).toHaveClass(
      "chatbox-host-composer"
    );
    expect(screen.getByTestId("fullscreen-composer")).toHaveStyle(
      "background-color: rgba(255, 255, 255, 1)"
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
      />
    );

    expect(screen.getByTestId("fullscreen-composer")).toHaveClass(
      "chatbox-host-composer"
    );
    expect(screen.getByTestId("fullscreen-composer")).toHaveStyle(
      "background-color: rgba(33, 33, 33, 1)"
    );
  });

  it("keeps the default fullscreen composer styling when no host style is active", () => {
    renderWithProviders(
      <FullscreenChatOverlay
        {...defaultProps}
        messages={[createMessage({ id: "msg-1", role: "user" })]}
        input="Follow up"
        canSend={true}
      />
    );

    expect(screen.getByTestId("fullscreen-composer")).toHaveClass(
      "rounded-full",
      "bg-background/95"
    );
  });

  it("keeps the fullscreen textarea editable while thinking", () => {
    renderWithProviders(
      <FullscreenChatOverlay
        {...defaultProps}
        input="Draft while thinking"
        isThinking={true}
      />
    );

    expect(screen.getByPlaceholderText("Message…")).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Stop generating" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send message" })
    ).not.toBeInTheDocument();
  });

  it("calls onStop from the fullscreen composer while thinking", () => {
    const onStop = vi.fn();

    renderWithProviders(
      <FullscreenChatOverlay
        {...defaultProps}
        input="Draft while thinking"
        isThinking={true}
        onStop={onStop}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("preserves the draft and re-enables send after thinking stops", () => {
    const { rerender } = renderWithProviders(
      <FullscreenChatOverlay
        {...defaultProps}
        input="Draft while thinking"
        isThinking={true}
      />
    );

    expect(screen.getByPlaceholderText("Message…")).toHaveValue(
      "Draft while thinking"
    );

    rerender(
      <FullscreenChatOverlay
        {...defaultProps}
        input="Draft while thinking"
        canSend={true}
        isThinking={false}
      />
    );

    expect(screen.getByPlaceholderText("Message…")).toHaveValue(
      "Draft while thinking"
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });
});
