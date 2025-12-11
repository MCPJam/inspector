import { useState } from "react";
import { UIMessage } from "@ai-sdk/react";

import { MessageView } from "./thread/message-view";
import { ModelDefinition } from "@/shared/types";
import { type DisplayMode } from "@/stores/ui-playground-store";
import { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { ThinkingIndicator } from "@/components/chat-v2/shared/thinking-indicator";

interface ThreadProps {
  messages: UIMessage[];
  sendFollowUpMessage: (text: string) => void;
  model: ModelDefinition;
  isLoading: boolean;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onFullscreenChange?: (isFullscreen: boolean) => void;
}

export function Thread({
  messages,
  sendFollowUpMessage,
  model,
  isLoading,
  toolsMetadata,
  toolServerMap,
  onWidgetStateChange,
  displayMode,
  onDisplayModeChange,
  onFullscreenChange,
}: ThreadProps) {
  const [pipWidgetId, setPipWidgetId] = useState<string | null>(null);
  const [fullscreenWidgetId, setFullscreenWidgetId] = useState<string | null>(
    null,
  );

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

  return (
    <div className="flex-1 min-h-0 pb-4">
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
            pipWidgetId={pipWidgetId}
            onRequestPip={handleRequestPip}
            onExitPip={handleExitPip}
            onRequestFullscreen={handleRequestFullscreen}
            onExitFullscreen={handleExitFullscreen}
            displayMode={displayMode}
            onDisplayModeChange={onDisplayModeChange}
          />
        ))}
        {isLoading && <ThinkingIndicator model={model} />}
      </div>
    </div>
  );
}
