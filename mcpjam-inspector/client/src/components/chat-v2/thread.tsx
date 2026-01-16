import { useEffect, useState } from "react";
import { UIMessage } from "@ai-sdk/react";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

import { MessageView } from "./thread/message-view";
import { ModelDefinition } from "@/shared/types";
import { type DisplayMode } from "@/stores/ui-playground-store";
import { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { ThinkingIndicator } from "@/components/chat-v2/shared/thinking-indicator";
import { FullscreenChatOverlay } from "@/components/chat-v2/fullscreen-chat-overlay";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";

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
  selectedProtocolOverrideIfBothExists?: UIType;
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
  selectedProtocolOverrideIfBothExists,
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
    !fullscreenChatDisabled && fullscreenChatInput.trim().length > 0;

  return (
    <div className="flex-1 min-h-0 pb-4">
      {/* Fixed spacer to reserve space for PIP widget */}
      {pipWidgetId && (
        <div className="h-[480px] flex-shrink-0 pointer-events-none" />
      )}
      <div className="max-w-4xl mx-auto px-4 pt-8 pb-16 space-y-8">
        {messages.map((message, idx) => (
          <MessageView
            key={idx}
            message={message}
            model={model}
            onSendFollowUp={sendFollowUpMessage}
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
          />
        ))}
        {isLoading && <ThinkingIndicator model={model} />}
      </div>

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
