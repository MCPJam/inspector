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
import { ArrowDown, Braces, Loader2, Trash2 } from "lucide-react";
import { useAuth } from "@workos-inc/authkit-react";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { ModelDefinition } from "@/shared/types";
import { cn } from "@/lib/utils";
import { Thread } from "@/components/chat-v2/thread";
import { ChatInput } from "@/components/chat-v2/chat-input";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { formatErrorMessage } from "@/components/chat-v2/shared/chat-helpers";
import { ErrorBox } from "@/components/chat-v2/error";
import { ConfirmChatResetDialog } from "@/components/chat-v2/chat-input/dialogs/confirm-chat-reset-dialog";
import { useChatSession } from "@/hooks/use-chat-session";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { createDeterministicToolMessages } from "./playground-helpers";
import type { MCPPromptResult } from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import type { SkillResult } from "@/components/chat-v2/chat-input/skills/skill-types";
import {
  type FileAttachment,
  attachmentsToFileUIParts,
  revokeFileAttachmentUrls,
} from "@/components/chat-v2/chat-input/attachments/file-utils";
import {
  useUIPlaygroundStore,
  type DeviceType,
  type DisplayMode,
} from "@/stores/ui-playground-store";
import {
  DisplayContextHeader,
  PRESET_DEVICE_CONFIGS,
} from "@/components/shared/DisplayContextHeader";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { FullscreenChatOverlay } from "@/components/chat-v2/fullscreen-chat-overlay";
import { useSharedAppState } from "@/state/app-state-context";
import { XRaySnapshotView } from "@/components/xray/xray-snapshot-view";
import { Settings2 } from "lucide-react";

/** Custom device config - dimensions come from store */
const CUSTOM_DEVICE_BASE = {
  label: "Custom",
  icon: Settings2,
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
  // Locale (BCP 47)
  locale?: string;
  onLocaleChange?: (locale: string) => void;
  // Timezone (IANA) per SEP-1865
  timeZone?: string;
  onTimeZoneChange?: (timeZone: string) => void;
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
  // Device/locale/timezone props are now managed via the store by DisplayContextHeader
  // These are kept for backward compatibility but are no longer used
  deviceType: _deviceType = "mobile",
  onDeviceTypeChange: _onDeviceTypeChange,
  displayMode = "inline",
  onDisplayModeChange,
  locale: _locale = "en-US",
  onLocaleChange: _onLocaleChange,
  timeZone: _timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC",
  onTimeZoneChange: _onTimeZoneChange,
}: PlaygroundMainProps) {
  const { signUp } = useAuth();
  const posthog = usePostHog();
  const clearLogs = useTrafficLogStore((s) => s.clear);
  const [input, setInput] = useState("");
  const [mcpPromptResults, setMcpPromptResults] = useState<MCPPromptResult[]>(
    [],
  );
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [skillResults, setSkillResults] = useState<SkillResult[]>([]);
  const [modelContextQueue, setModelContextQueue] = useState<
    {
      toolCallId: string;
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      };
    }[]
  >([]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [xrayMode, setXrayMode] = useState(false);
  const [isWidgetFullscreen, setIsWidgetFullscreen] = useState(false);
  const [isFullscreenChatOpen, setIsFullscreenChatOpen] = useState(false);
  // Device config from store (managed by DisplayContextHeader)
  const storeDeviceType = useUIPlaygroundStore((s) => s.deviceType);
  const customViewport = useUIPlaygroundStore((s) => s.customViewport);

  // Device config for frame sizing
  const deviceConfig = useMemo(() => {
    if (storeDeviceType === "custom") {
      return {
        ...CUSTOM_DEVICE_BASE,
        width: customViewport.width,
        height: customViewport.height,
      };
    }
    return PRESET_DEVICE_CONFIGS[storeDeviceType];
  }, [storeDeviceType, customViewport]);

  const { servers } = useSharedAppState();
  const selectedServers = useMemo(
    () =>
      serverName && servers[serverName]?.connectionStatus === "connected"
        ? [serverName]
        : [],
    [serverName, servers],
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

  // Currently selected protocol (detected from tool metadata)
  const selectedProtocol = useUIPlaygroundStore((s) => s.selectedProtocol);

  // Check if thread is empty
  const isThreadEmpty = !messages.some(
    (msg) => msg.role === "user" || msg.role === "assistant",
  );

  // Keyboard shortcut for clear chat (Cmd/Ctrl+Shift+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        if (!isThreadEmpty) {
          setShowClearConfirm(true);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isThreadEmpty]);

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

  // Handle model context updates from widgets (SEP-1865 ui/update-model-context)
  const handleModelContextUpdate = useCallback(
    (
      toolCallId: string,
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      },
    ) => {
      // Queue model context to be included in next message
      setModelContextQueue((prev) => {
        // Remove any existing context from same widget (overwrite pattern per SEP-1865)
        const filtered = prev.filter((item) => item.toolCallId !== toolCallId);
        return [...filtered, { toolCallId, context }];
      });
    },
    [],
  );

  // Handle clear chat
  const handleClearChat = useCallback(() => {
    resetChat();
    clearLogs();
    setShowClearConfirm(false);
  }, [resetChat, clearLogs]);

  // Placeholder text
  let placeholder = "Ask something to render UI...";
  if (isAuthLoading) {
    placeholder = "Loading...";
  } else if (disableForAuthentication) {
    placeholder = "Sign in to use chat";
  }

  const shouldShowUpsell = disableForAuthentication && !isAuthLoading;
  const handleSignUp = () => {
    posthog.capture("sign_up_button_clicked", {
      location: "app_builder_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    signUp();
  };

  // Submit handler
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const hasContent =
      input.trim() || mcpPromptResults.length > 0 || fileAttachments.length > 0;
    if (hasContent && status === "ready" && !submitBlocked) {
      if (displayMode === "fullscreen" && isWidgetFullscreen) {
        setIsFullscreenChatOpen(true);
      }
      posthog.capture("app_builder_send_message", {
        location: "app_builder_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
      });

      // Include any pending model context from widgets (SEP-1865 ui/update-model-context)
      // Sent as "user" messages for compatibility with model provider APIs
      const contextMessages = modelContextQueue.map(
        ({ toolCallId, context }) => ({
          id: `model-context-${toolCallId}-${Date.now()}`,
          role: "user" as const,
          parts: [
            {
              type: "text" as const,
              text: `Widget ${toolCallId} context: ${JSON.stringify(context)}`,
            },
          ],
          metadata: {
            source: "widget-model-context",
            toolCallId,
          },
        }),
      );

      if (contextMessages.length > 0) {
        setMessages((prev) => [...prev, ...contextMessages]);
      }

      // Convert file attachments to FileUIPart[] format for the AI SDK
      const files =
        fileAttachments.length > 0
          ? await attachmentsToFileUIParts(fileAttachments)
          : undefined;

      sendMessage({ text: input, files });
      setInput("");
      setMcpPromptResults([]);
      // Revoke object URLs and clear file attachments
      revokeFileAttachmentUrls(fileAttachments);
      setFileAttachments([]);
      setModelContextQueue([]); // Clear after sending
    }
  };

  const errorMessage = formatErrorMessage(error);
  const inputDisabled = status !== "ready" || submitBlocked;

  // Compact mode for smaller devices or narrow custom viewports
  const isCompact = useMemo(() => {
    if (storeDeviceType === "mobile" || storeDeviceType === "tablet")
      return true;
    if (storeDeviceType === "custom" && customViewport.width < 500) return true;
    return false;
  }, [storeDeviceType, customViewport.width]);

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
    connectedOrConnectingServerConfigs: { [serverName]: { name: serverName } },
    systemPromptTokenCount: null,
    systemPromptTokenCountLoading: false,
    mcpPromptResults,
    onChangeMcpPromptResults: setMcpPromptResults,
    skillResults,
    onChangeSkillResults: setSkillResults,
    compact: isCompact,
    fileAttachments,
    onChangeFileAttachments: setFileAttachments,
    xrayMode,
    onXrayModeChange: setXrayMode,
  };

  // Check if widget should take over the full container
  // Mobile: both fullscreen and pip take over
  // Tablet: only fullscreen takes over (pip stays floating)
  const isMobileFullTakeover =
    storeDeviceType === "mobile" &&
    (displayMode === "fullscreen" || displayMode === "pip");
  const isTabletFullscreenTakeover =
    storeDeviceType === "tablet" && displayMode === "fullscreen";
  const isWidgetFullTakeover =
    isMobileFullTakeover || isTabletFullscreenTakeover;

  const showFullscreenChatOverlay =
    displayMode === "fullscreen" &&
    isWidgetFullscreen &&
    storeDeviceType === "desktop" &&
    !isWidgetFullTakeover;

  useEffect(() => {
    if (!showFullscreenChatOverlay) setIsFullscreenChatOpen(false);
  }, [showFullscreenChatOverlay]);

  // Thread content - single ChatInput that persists across empty/non-empty states
  const threadContent = (
    <div className="relative flex flex-col flex-1 min-h-0">
      {isThreadEmpty ? (
        // Empty state - centered welcome message
        <div className="flex-1 flex items-center justify-center overflow-y-auto overflow-x-hidden px-4 min-h-0">
          <div className="text-center max-w-md mx-auto space-y-6 py-8">
            {isAuthLoading ? (
              <div className="space-y-4">
                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                <p className="text-sm text-muted-foreground">Loading...</p>
              </div>
            ) : shouldShowUpsell ? (
              <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
            ) : (
              <h3 className="text-sm font-semibold text-foreground mb-2">
                Test ChatGPT Apps and MCP Apps
              </h3>
            )}
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
                onModelContextUpdate={handleModelContextUpdate}
                displayMode={displayMode}
                onDisplayModeChange={onDisplayModeChange}
                onFullscreenChange={setIsWidgetFullscreen}
                selectedProtocolOverrideIfBothExists={
                  selectedProtocol ?? undefined
                }
              />
              {/* Invoking indicator while tool execution is in progress */}
              {isExecuting && executingToolName && (
                <InvokingIndicator
                  toolName={executingToolName}
                  customMessage={invokingMessage}
                />
              )}
            </StickToBottom.Content>
            <ScrollToBottomButton />
          </div>
        </StickToBottom>
      )}

      {/* Single ChatInput that persists - hidden when widget takes over */}
      {!isWidgetFullTakeover && !showFullscreenChatOverlay && (
        <div
          className={cn(
            "flex-shrink-0 max-w-3xl mx-auto w-full",
            isThreadEmpty
              ? "px-4 pb-4"
              : "bg-background/80 backdrop-blur-sm p-3",
          )}
        >
          {errorMessage && (
            <div className="pb-3">
              <ErrorBox
                message={errorMessage.message}
                errorDetails={errorMessage.details}
                code={errorMessage.code}
                statusCode={errorMessage.statusCode}
                isRetryable={errorMessage.isRetryable}
                isMCPJamPlatformError={errorMessage.isMCPJamPlatformError}
                onResetChat={resetChat}
              />
            </div>
          )}
          <ChatInput {...sharedChatInputProps} hasMessages={!isThreadEmpty} />
        </div>
      )}

      {/* Fullscreen overlay chat (input pinned + collapsible thread) */}
      {showFullscreenChatOverlay && (
        <FullscreenChatOverlay
          messages={messages}
          open={isFullscreenChatOpen}
          onOpenChange={setIsFullscreenChatOpen}
          input={input}
          onInputChange={setInput}
          placeholder={placeholder}
          disabled={inputDisabled}
          canSend={
            status === "ready" && !submitBlocked && input.trim().length > 0
          }
          isThinking={status === "submitted"}
          onSend={() => {
            sendMessage({ text: input });
            setInput("");
            setMcpPromptResults([]);
          }}
        />
      )}
    </div>
  );

  // Device frame container - display mode is passed to widgets via Thread
  return (
    <div className="h-full flex flex-col bg-muted/20 overflow-hidden">
      {/* Device frame header */}
      <div className="relative flex items-center justify-center px-3 py-2 border-b border-border bg-background/50 text-xs text-muted-foreground flex-shrink-0">
        {/* All controls centered */}
        <DisplayContextHeader protocol={selectedProtocol} showThemeToggle />

        {/* Right actions - absolutely positioned */}
        {!isThreadEmpty && (
          <div className="absolute right-3">
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
              <TooltipContent>
                <p>Clear chat</p>
                <p className="text-xs text-muted-foreground">
                  {navigator.platform.includes("Mac") ? "⌘⇧K" : "Ctrl+Shift+K"}
                </p>
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      <ConfirmChatResetDialog
        open={showClearConfirm}
        onCancel={() => setShowClearConfirm(false)}
        onConfirm={handleClearChat}
      />

      {/* Device frame container */}
      <div className="flex-1 flex items-center justify-center min-h-0 overflow-auto">
        <div
          className="relative bg-background flex flex-col overflow-hidden"
          style={{
            width: deviceConfig.width,
            maxWidth: "100%",
            height: isWidgetFullTakeover ? "100%" : deviceConfig.height,
            maxHeight: "100%",
            transform: isWidgetFullscreen ? "none" : "translateZ(0)",
          }}
        >
          {xrayMode ? (
            <StickToBottom
              className="relative flex flex-1 flex-col min-h-0"
              resize="smooth"
              initial="smooth"
            >
              <div className="relative flex-1 min-h-0">
                <StickToBottom.Content className="flex flex-col min-h-0">
                  <XRaySnapshotView
                    systemPrompt={systemPrompt}
                    messages={messages}
                    selectedServers={selectedServers}
                    onClose={() => setXrayMode(false)}
                  />
                </StickToBottom.Content>
                <ScrollToBottomButton />
              </div>
              <div className="flex-shrink-0 bg-background/80 backdrop-blur-sm border-t border-border">
                <div className="max-w-xl mx-auto w-full p-3">
                  <ChatInput
                    {...sharedChatInputProps}
                    hasMessages={!isThreadEmpty}
                  />
                </div>
              </div>
            </StickToBottom>
          ) : (
            threadContent
          )}
        </div>
      </div>
    </div>
  );
}
