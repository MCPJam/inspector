/**
 * PlaygroundMain
 *
 * Main center panel for the UI Playground that combines:
 * - Deterministic tool execution (injected as messages)
 * - LLM-driven chat continuation
 * - Widget rendering via Thread component
 *
 * Uses the shared useChatSession hook for chat infrastructure.
 * Device/display mode handling is delegated to the Thread component
 * which manages PiP/fullscreen at the widget level.
 */

import { FormEvent, useState, useEffect, useCallback, useMemo } from "react";
import {
  ArrowDown,
  Braces,
  LayoutTemplate,
  Loader2,
  Wrench,
  Smartphone,
  Tablet,
  Monitor,
  Trash2,
  Sun,
  Moon,
} from "lucide-react";
import { ModelDefinition } from "@/shared/types";
import { Thread } from "@/components/chat-v2/thread";
import { ChatInput } from "@/components/chat-v2/chat-input";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { formatErrorMessage } from "@/components/chat-v2/chat-helpers";
import { ErrorBox } from "@/components/chat-v2/error";
import { ConfirmChatResetDialog } from "@/components/chat-v2/confirm-chat-reset-dialog";
import { useChatSession } from "@/hooks/use-chat-session";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { updateThemeMode } from "@/lib/theme-utils";
import { createDeterministicToolMessages } from "./playground-helpers";
import type { MCPPromptResult } from "@/components/chat-v2/mcp-prompts-popover";
import {
  useUIPlaygroundStore,
  type DeviceType,
  type DisplayMode,
} from "@/stores/ui-playground-store";

/** Device frame configurations */
const DEVICE_CONFIGS: Record<
  DeviceType,
  { width: number; height: number; label: string; icon: typeof Smartphone }
> = {
  mobile: { width: 430, height: 932, label: "Phone", icon: Smartphone },
  tablet: { width: 820, height: 1180, label: "Tablet", icon: Tablet },
  desktop: { width: 1280, height: 800, label: "Desktop", icon: Monitor },
};

interface PlaygroundMainProps {
  serverName: string;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
  // Execution state for "Invoking" indicator
  isExecuting?: boolean;
  executingToolName?: string | null;
  invokingMessage?: string | null;
  // Deterministic execution
  pendingExecution: {
    toolName: string;
    params: Record<string, unknown>;
    result: unknown;
    toolMeta: Record<string, unknown> | undefined;
  } | null;
  onExecutionInjected: () => void;
  // Device emulation
  deviceType?: DeviceType;
  onDeviceTypeChange?: (type: DeviceType) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
}

function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 flex bottom-12 justify-center animate-in slide-in-from-bottom fade-in duration-200">
      <button
        type="button"
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-border bg-background/90 px-2 py-2 text-xs font-medium shadow-sm transition hover:bg-accent"
        onClick={() => scrollToBottom({ animation: "smooth" })}
      >
        <ArrowDown className="h-4 w-4" />
      </button>
    </div>
  );
}

// Invoking indicator component (ChatGPT-style "Invoking [toolName]")
function InvokingIndicator({
  toolName,
  customMessage,
}: {
  toolName: string;
  customMessage?: string | null;
}) {
  return (
    <div className="max-w-4xl mx-auto px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <Braces className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        {customMessage ? (
          <span>{customMessage}</span>
        ) : (
          <>
            <span>Invoking</span>
            <code className="text-primary font-mono">{toolName}</code>
          </>
        )}
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
      </div>
    </div>
  );
}

export function PlaygroundMain({
  serverName,
  onWidgetStateChange,
  isExecuting,
  executingToolName,
  invokingMessage,
  pendingExecution,
  onExecutionInjected,
  deviceType = "mobile",
  onDeviceTypeChange,
  displayMode = "inline",
  onDisplayModeChange,
}: PlaygroundMainProps) {
  const [input, setInput] = useState("");
  const [mcpPromptResults, setMcpPromptResults] = useState<MCPPromptResult[]>(
    [],
  );
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Device config
  const deviceConfig = DEVICE_CONFIGS[deviceType];
  const DeviceIcon = deviceConfig.icon;

  // Theme handling
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);

  const handleThemeChange = useCallback(() => {
    const newTheme = themeMode === "dark" ? "light" : "dark";
    updateThemeMode(newTheme);
    setThemeMode(newTheme);
  }, [themeMode, setThemeMode]);

  // Single server for playground
  const selectedServers = useMemo(
    () => (serverName ? [serverName] : []),
    [serverName],
  );

  // Use shared chat session hook
  const {
    messages,
    setMessages,
    sendMessage,
    stop,
    status,
    error,
    selectedModel,
    setSelectedModel,
    availableModels,
    isAuthLoading,
    systemPrompt,
    setSystemPrompt,
    temperature,
    setTemperature,
    toolsMetadata,
    toolServerMap,
    tokenUsage,
    resetChat,
    isStreaming,
    disableForAuthentication,
    submitBlocked,
  } = useChatSession({
    selectedServers,
    onReset: () => {
      setInput("");
    },
  });

  // Set playground active flag for widget renderers to read
  const setPlaygroundActive = useUIPlaygroundStore(
    (s) => s.setPlaygroundActive,
  );
  useEffect(() => {
    setPlaygroundActive(true);
    return () => setPlaygroundActive(false);
  }, [setPlaygroundActive]);

  // Check if thread is empty
  const isThreadEmpty = !messages.some(
    (msg) => msg.role === "user" || msg.role === "assistant",
  );

  // Handle deterministic execution injection
  useEffect(() => {
    if (!pendingExecution) return;

    const { toolName, params, result, toolMeta } = pendingExecution;
    const { messages: newMessages } = createDeterministicToolMessages(
      toolName,
      params,
      result,
      toolMeta,
    );

    setMessages((prev) => [...prev, ...newMessages]);
    onExecutionInjected();
  }, [pendingExecution, setMessages, onExecutionInjected]);

  // Handle widget state changes
  const handleWidgetStateChange = useCallback(
    (toolCallId: string, state: unknown) => {
      onWidgetStateChange?.(toolCallId, state);
    },
    [onWidgetStateChange],
  );

  // Handle follow-up messages from widgets
  const handleSendFollowUp = useCallback(
    (text: string) => {
      sendMessage({ text });
    },
    [sendMessage],
  );

  // Handle clear chat
  const handleClearChat = useCallback(() => {
    resetChat();
    setShowClearConfirm(false);
  }, [resetChat]);

  // Placeholder text
  let placeholder = "Ask about the tool result or continue the conversation...";
  if (isAuthLoading) {
    placeholder = "Loading...";
  } else if (disableForAuthentication) {
    placeholder = "Sign in to use chat";
  }

  // Submit handler
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      (input.trim() || mcpPromptResults.length > 0) &&
      status === "ready" &&
      !submitBlocked
    ) {
      sendMessage({ text: input });
      setInput("");
      setMcpPromptResults([]);
    }
  };

  const errorMessage = formatErrorMessage(error);
  const inputDisabled = status !== "ready" || submitBlocked;

  // Shared chat input props
  const sharedChatInputProps = {
    value: input,
    onChange: setInput,
    onSubmit,
    stop,
    disabled: inputDisabled,
    isLoading: isStreaming,
    placeholder,
    currentModel: selectedModel,
    availableModels,
    onModelChange: (model: ModelDefinition) => {
      setSelectedModel(model);
      resetChat();
    },
    systemPrompt,
    onSystemPromptChange: setSystemPrompt,
    temperature,
    onTemperatureChange: setTemperature,
    onResetChat: resetChat,
    submitDisabled: submitBlocked,
    tokenUsage,
    selectedServers,
    mcpToolsTokenCount: null,
    mcpToolsTokenCountLoading: false,
    connectedServerConfigs: { [serverName]: { name: serverName } },
    systemPromptTokenCount: null,
    systemPromptTokenCountLoading: false,
    mcpPromptResults,
    onChangeMcpPromptResults: setMcpPromptResults,
  };

  // Thread content
  const threadContent = (
    <>
      {isThreadEmpty ? (
        // Empty state
        <div className="flex-1 flex items-center justify-center overflow-y-auto px-4">
          <div className="w-full max-w-xl space-y-6 py-8">
            <div className="text-center max-w-md mx-auto">
              <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
                <LayoutTemplate className="h-7 w-7 text-muted-foreground" />
              </div>
              <h3 className="text-sm font-semibold text-foreground mb-2">
                Ready to test
              </h3>
              <p className="text-xs text-muted-foreground mb-4">
                Select a tool from the sidebar and click Execute to see results
                here. You can then chat to ask questions about the results.
              </p>
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Wrench className="h-3.5 w-3.5" />
                <span>
                  Connected to <code className="font-mono">{serverName}</code>
                </span>
              </div>
            </div>
            <ChatInput {...sharedChatInputProps} hasMessages={false} />
          </div>
        </div>
      ) : (
        // Thread with messages
        <StickToBottom
          className="relative flex flex-1 flex-col min-h-0"
          resize="smooth"
          initial="smooth"
        >
          <div className="relative flex-1 min-h-0">
            <StickToBottom.Content className="flex flex-col min-h-0">
              <Thread
                messages={messages}
                sendFollowUpMessage={handleSendFollowUp}
                model={selectedModel}
                isLoading={status === "submitted"}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={handleWidgetStateChange}
                displayMode={displayMode}
                onDisplayModeChange={onDisplayModeChange}
              />
              {/* Invoking indicator while tool execution is in progress */}
              {isExecuting && executingToolName && (
                <InvokingIndicator
                  toolName={executingToolName}
                  customMessage={invokingMessage}
                />
              )}
              {errorMessage && (
                <div className="px-4 pb-4 pt-4">
                  <ErrorBox
                    message={errorMessage.message}
                    errorDetails={errorMessage.details}
                    onResetChat={resetChat}
                  />
                </div>
              )}
            </StickToBottom.Content>
            <ScrollToBottomButton />
          </div>

          <div className="bg-background/80 backdrop-blur-sm border-t border-border flex-shrink-0">
            <div className="p-3">
              <ChatInput {...sharedChatInputProps} hasMessages />
            </div>
          </div>
        </StickToBottom>
      )}
    </>
  );

  // Device frame container - display mode is passed to widgets via Thread
  return (
    <div className="h-full flex flex-col bg-muted/20 overflow-hidden">
      {/* Device frame header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-background/50 text-xs text-muted-foreground flex-shrink-0">
        {/* Device type toggle */}
        <ToggleGroup
          type="single"
          value={deviceType}
          onValueChange={(v) => v && onDeviceTypeChange?.(v as DeviceType)}
          className="gap-0.5"
        >
          <ToggleGroupItem
            value="mobile"
            aria-label="Mobile"
            title="Mobile (430×932)"
            className="h-7 w-7 p-0"
          >
            <Smartphone className="h-3.5 w-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="tablet"
            aria-label="Tablet"
            title="Tablet (820×1180)"
            className="h-7 w-7 p-0"
          >
            <Tablet className="h-3.5 w-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="desktop"
            aria-label="Desktop"
            title="Desktop (1280×800)"
            className="h-7 w-7 p-0"
          >
            <Monitor className="h-3.5 w-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>

        {/* Device label */}
        <div className="flex items-center gap-2">
          <DeviceIcon className="h-3.5 w-3.5" />
          <span>{deviceConfig.label}</span>
          <span className="text-[10px] text-muted-foreground/60">
            ({deviceConfig.width}×{deviceConfig.height})
          </span>
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleThemeChange}
                className="h-7 w-7"
                title={`Switch to ${themeMode === "dark" ? "light" : "dark"} mode`}
              >
                {themeMode === "dark" ? (
                  <Sun className="h-3.5 w-3.5" />
                ) : (
                  <Moon className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {themeMode === "dark" ? "Light mode" : "Dark mode"}
            </TooltipContent>
          </Tooltip>
          {!isThreadEmpty && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowClearConfirm(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear chat</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <ConfirmChatResetDialog
        open={showClearConfirm}
        onCancel={() => setShowClearConfirm(false)}
        onConfirm={handleClearChat}
      />

      {/* Device frame container */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0 overflow-auto">
        <div
          className="bg-background border border-border rounded-xl shadow-lg flex flex-col overflow-hidden"
          style={{
            width: deviceConfig.width,
            maxWidth: "100%",
            height: deviceConfig.height,
            maxHeight: "100%",
            transform: "translateZ(0)", // Creates containing block for fixed positioned elements (fullscreen/pip modes)
          }}
        >
          {threadContent}
        </div>
      </div>
    </div>
  );
}
