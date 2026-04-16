import { useEffect, useMemo, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import {
  useSandboxHostStyle,
  useSandboxHostTheme,
} from "@/contexts/sandbox-host-style-context";
import { UIMessage } from "@ai-sdk/react";
import type { ContentBlock } from "@modelcontextprotocol/client";
import type { TranscriptThreadProps } from "./thread/transcript-thread";

import { ModelDefinition } from "@/shared/types";
import { type DisplayMode } from "@/stores/ui-playground-store";
import { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { ThinkingIndicator } from "@/components/chat-v2/shared/thinking-indicator";
import { FullscreenChatOverlay } from "@/components/chat-v2/fullscreen-chat-overlay";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import {
  type LoadingIndicatorVariant,
  useResolvedLoadingIndicatorVariant,
} from "@/components/chat-v2/shared/loading-indicator-content";
import { type ReasoningDisplayMode } from "./thread/parts/reasoning-part";
import { TranscriptThread } from "./thread/transcript-thread";
import {
  getLastRenderableConversationMessage,
  hasRenderableConversationContent,
} from "./thread/thread-helpers";

interface ThreadProps {
  messages: UIMessage[];
  sendFollowUpMessage: (text: string) => void;
  model: ModelDefinition;
  isLoading: boolean;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  onModelContextUpdate?: (
    toolCallId: string,
    context: {
      content?: ContentBlock[];
      structuredContent?: Record<string, unknown>;
    },
  ) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onFullscreenChange?: (isFullscreen: boolean) => void;
  enableFullscreenChatOverlay?: boolean;
  fullscreenChatPlaceholder?: string;
  fullscreenChatDisabled?: boolean;
  fullscreenChatSendBlocked?: boolean;
  onFullscreenChatStop?: () => void;
  selectedProtocolOverrideIfBothExists?: UIType;
  onToolApprovalResponse?: (options: { id: string; approved: boolean }) => void;
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  showSaveViewButton?: boolean;
  minimalMode?: boolean;
  interactive?: boolean;
  loadingIndicatorVariant?: LoadingIndicatorVariant;
  reasoningDisplayMode?: ReasoningDisplayMode;
  focusMessageId?: string | null;
  highlightedMessageIds?: string[];
  navigationKey?: string | number | null;
  viewportRef?: RefObject<HTMLElement | null>;
  contentClassName?: string;
  getMessageWrapperProps?: TranscriptThreadProps["getMessageWrapperProps"];
}

export function Thread({
  messages,
  sendFollowUpMessage,
  model,
  isLoading,
  toolsMetadata,
  toolServerMap,
  onWidgetStateChange,
  onModelContextUpdate,
  displayMode,
  onDisplayModeChange,
  onFullscreenChange,
  enableFullscreenChatOverlay = false,
  fullscreenChatPlaceholder = "Message…",
  fullscreenChatDisabled = false,
  fullscreenChatSendBlocked = isLoading,
  onFullscreenChatStop,
  selectedProtocolOverrideIfBothExists,
  onToolApprovalResponse,
  toolRenderOverrides,
  showSaveViewButton = true,
  minimalMode = false,
  interactive = true,
  loadingIndicatorVariant,
  reasoningDisplayMode = "inline",
  focusMessageId = null,
  highlightedMessageIds = [],
  navigationKey = null,
  viewportRef,
  contentClassName,
  getMessageWrapperProps,
}: ThreadProps) {
  const [pipWidgetId, setPipWidgetId] = useState<string | null>(null);
  const [fullscreenWidgetId, setFullscreenWidgetId] = useState<string | null>(
    null,
  );
  const [isFullscreenChatOpen, setIsFullscreenChatOpen] = useState(false);
  const [fullscreenChatInput, setFullscreenChatInput] = useState("");

  const handleRequestPip = (toolCallId: string) => {
    setPipWidgetId(toolCallId);
  };

  const handleExitPip = (toolCallId: string) => {
    if (pipWidgetId === toolCallId) {
      setPipWidgetId(null);
    }
  };

  const handleRequestFullscreen = (toolCallId: string) => {
    setFullscreenWidgetId(toolCallId);
    onFullscreenChange?.(true);
  };

  const handleExitFullscreen = (toolCallId: string) => {
    if (fullscreenWidgetId === toolCallId) {
      setFullscreenWidgetId(null);
      onFullscreenChange?.(false);
    }
  };

  const showFullscreenChatOverlay =
    enableFullscreenChatOverlay && fullscreenWidgetId !== null;

  useEffect(() => {
    if (!showFullscreenChatOverlay) {
      setIsFullscreenChatOpen(false);
      setFullscreenChatInput("");
    }
  }, [showFullscreenChatOverlay]);

  const canSendFullscreenChat =
    !fullscreenChatDisabled &&
    !fullscreenChatSendBlocked &&
    fullscreenChatInput.trim().length > 0;

  const sandboxHostStyle = useSandboxHostStyle();
  const sandboxHostTheme = useSandboxHostTheme();
  const resolvedLoadingIndicatorVariant = useResolvedLoadingIndicatorVariant(
    loadingIndicatorVariant,
    {
      modelProvider: model.provider,
    },
  );
  const isChatgptDark =
    sandboxHostStyle === "chatgpt" && sandboxHostTheme === "dark";
  const lastRenderableMessage = useMemo(
    () => getLastRenderableConversationMessage(messages),
    [messages],
  );
  const hasVisibleAssistantResponse =
    lastRenderableMessage?.role === "assistant" &&
    hasRenderableConversationContent(lastRenderableMessage);
  const lastRenderableMessageId = hasVisibleAssistantResponse
    ? lastRenderableMessage.id
    : null;
  const shouldShowStandaloneThinkingIndicator =
    resolvedLoadingIndicatorVariant === "claude-mark" ||
    resolvedLoadingIndicatorVariant === "chatgpt-dot"
      ? isLoading && !hasVisibleAssistantResponse
      : isLoading;

  return (
    <div
      className={cn(
        "flex-1 min-h-0 min-w-0 pb-4",
        isChatgptDark && "bg-[#212121] text-[#DFDFDF]",
      )}
    >
      {/* Fixed spacer to reserve space for PIP widget */}
      {pipWidgetId && (
        <div className="h-[480px] flex-shrink-0 pointer-events-none" />
      )}
      <TranscriptThread
        messages={messages}
        model={model}
        sendFollowUpMessage={sendFollowUpMessage}
        toolsMetadata={toolsMetadata}
        toolServerMap={toolServerMap}
        onWidgetStateChange={onWidgetStateChange}
        onModelContextUpdate={onModelContextUpdate}
        pipWidgetId={pipWidgetId}
        fullscreenWidgetId={fullscreenWidgetId}
        onRequestPip={handleRequestPip}
        onExitPip={handleExitPip}
        onRequestFullscreen={handleRequestFullscreen}
        onExitFullscreen={handleExitFullscreen}
        displayMode={displayMode}
        onDisplayModeChange={onDisplayModeChange}
        selectedProtocolOverrideIfBothExists={
          selectedProtocolOverrideIfBothExists
        }
        onToolApprovalResponse={onToolApprovalResponse}
        toolRenderOverrides={toolRenderOverrides}
        showSaveViewButton={showSaveViewButton}
        minimalMode={minimalMode}
        interactive={interactive}
        reasoningDisplayMode={reasoningDisplayMode}
        focusMessageId={focusMessageId}
        highlightedMessageIds={highlightedMessageIds}
        navigationKey={navigationKey}
        viewportRef={viewportRef}
        isLoading={isLoading}
        resolvedLoadingIndicatorVariant={resolvedLoadingIndicatorVariant}
        lastRenderableMessageId={lastRenderableMessageId}
        contentClassName={
          contentClassName ??
          "min-w-0 w-full max-w-4xl mx-auto px-4 pt-8 pb-16 space-y-8"
        }
        getMessageWrapperProps={getMessageWrapperProps}
      />
      {shouldShowStandaloneThinkingIndicator && (
        <div className="min-w-0 w-full max-w-4xl mx-auto px-4">
          <ThinkingIndicator
            model={model}
            resolvedVariant={resolvedLoadingIndicatorVariant}
          />
        </div>
      )}

      {showFullscreenChatOverlay && (
        <FullscreenChatOverlay
          messages={messages}
          open={isFullscreenChatOpen}
          onOpenChange={setIsFullscreenChatOpen}
          input={fullscreenChatInput}
          onInputChange={setFullscreenChatInput}
          placeholder={fullscreenChatPlaceholder}
          disabled={fullscreenChatDisabled}
          canSend={canSendFullscreenChat}
          isThinking={isLoading}
          loadingIndicatorVariant={resolvedLoadingIndicatorVariant}
          onStop={onFullscreenChatStop}
          onSend={() => {
            if (!canSendFullscreenChat) return;
            const text = fullscreenChatInput;
            setIsFullscreenChatOpen(true);
            setFullscreenChatInput("");
            sendFollowUpMessage(text);
          }}
        />
      )}
    </div>
  );
}
