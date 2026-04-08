import { memo } from "react";
import { UIMessage } from "@ai-sdk/react";
import { MessageCircle } from "lucide-react";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

import { UserMessageBubble } from "./user-message-bubble";
import { PartSwitch } from "./part-switch";
import { ModelDefinition } from "@/shared/types";
import { type DisplayMode } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useSandboxHostStyle,
  useSandboxHostTheme,
} from "@/contexts/sandbox-host-style-context";
import { groupAssistantPartsIntoSteps } from "./thread-helpers";
import { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { type ReasoningDisplayMode } from "./parts/reasoning-part";
import { ClaudeLoadingIndicator } from "@/components/chat-v2/shared/claude-loading-indicator";
import { getAssistantAvatarDescriptor } from "@/components/chat-v2/shared/assistant-avatar";

type ClaudeFooterMode = "none" | "animated" | "static";

interface MessageViewProps {
  message: UIMessage;
  model: ModelDefinition;
  onSendFollowUp: (text: string) => void;
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
  pipWidgetId: string | null;
  fullscreenWidgetId: string | null;
  onRequestPip: (toolCallId: string) => void;
  onExitPip: (toolCallId: string) => void;
  onRequestFullscreen: (toolCallId: string) => void;
  onExitFullscreen: (toolCallId: string) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  selectedProtocolOverrideIfBothExists?: UIType;
  onToolApprovalResponse?: (options: { id: string; approved: boolean }) => void;
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  showSaveViewButton?: boolean;
  minimalMode?: boolean;
  interactive?: boolean;
  reasoningDisplayMode?: ReasoningDisplayMode;
  claudeFooterMode?: ClaudeFooterMode;
}

function shouldRerenderMessage(prevMessage: UIMessage, nextMessage: UIMessage) {
  return !(
    prevMessage === nextMessage ||
    (prevMessage.id === nextMessage.id &&
      prevMessage.role === nextMessage.role &&
      prevMessage.parts === nextMessage.parts)
  );
}

function areMessageViewPropsEqual(
  prev: Readonly<MessageViewProps>,
  next: Readonly<MessageViewProps>,
) {
  return (
    !shouldRerenderMessage(prev.message, next.message) &&
    prev.model === next.model &&
    prev.onSendFollowUp === next.onSendFollowUp &&
    prev.toolsMetadata === next.toolsMetadata &&
    prev.toolServerMap === next.toolServerMap &&
    prev.onWidgetStateChange === next.onWidgetStateChange &&
    prev.onModelContextUpdate === next.onModelContextUpdate &&
    prev.pipWidgetId === next.pipWidgetId &&
    prev.fullscreenWidgetId === next.fullscreenWidgetId &&
    prev.onRequestPip === next.onRequestPip &&
    prev.onExitPip === next.onExitPip &&
    prev.onRequestFullscreen === next.onRequestFullscreen &&
    prev.onExitFullscreen === next.onExitFullscreen &&
    prev.displayMode === next.displayMode &&
    prev.onDisplayModeChange === next.onDisplayModeChange &&
    prev.selectedProtocolOverrideIfBothExists ===
      next.selectedProtocolOverrideIfBothExists &&
    prev.onToolApprovalResponse === next.onToolApprovalResponse &&
    prev.toolRenderOverrides === next.toolRenderOverrides &&
    prev.showSaveViewButton === next.showSaveViewButton &&
    prev.minimalMode === next.minimalMode &&
    prev.interactive === next.interactive &&
    prev.reasoningDisplayMode === next.reasoningDisplayMode &&
    prev.claudeFooterMode === next.claudeFooterMode
  );
}

function MessageViewImpl({
  message,
  model,
  onSendFollowUp,
  toolsMetadata,
  toolServerMap,
  onWidgetStateChange,
  onModelContextUpdate,
  pipWidgetId,
  fullscreenWidgetId,
  onRequestPip,
  onExitPip,
  onRequestFullscreen,
  onExitFullscreen,
  displayMode,
  onDisplayModeChange,
  selectedProtocolOverrideIfBothExists,
  onToolApprovalResponse,
  toolRenderOverrides,
  showSaveViewButton = true,
  minimalMode = false,
  interactive = true,
  reasoningDisplayMode = "inline",
  claudeFooterMode = "none",
}: MessageViewProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const sandboxHostStyle = useSandboxHostStyle();
  const sandboxHostTheme = useSandboxHostTheme();
  const assistantAvatar = getAssistantAvatarDescriptor({
    model,
    themeMode: sandboxHostTheme ?? themeMode,
    sandboxHostStyle,
  });
  const shouldRenderAssistantAvatar = sandboxHostStyle === null;
  // Hide widget state messages (these are internal and sent to the model)
  if (message.id?.startsWith("widget-state-")) return null;
  // Hide model context messages (these are internal and sent to the model)
  if (message.id?.startsWith("model-context-")) return null;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;

  if (role === "user") {
    // Separate file parts from other parts - files render above the bubble
    const fileParts =
      message.parts?.filter((part) => part.type === "file") ?? [];
    const otherParts =
      message.parts?.filter((part) => part.type !== "file") ?? [];

    return (
      <div className="flex w-full min-w-0 flex-col items-end gap-2">
        {/* File attachments above the bubble */}
        {fileParts.length > 0 && (
          <div className="flex max-w-[min(100%,48rem)] flex-wrap justify-end gap-2">
            {fileParts.map((part, i) => (
              <PartSwitch
                key={`file-${i}`}
                part={part}
                role={role}
                onSendFollowUp={onSendFollowUp}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={onWidgetStateChange}
                onModelContextUpdate={onModelContextUpdate}
                pipWidgetId={pipWidgetId}
                fullscreenWidgetId={fullscreenWidgetId}
                onRequestPip={onRequestPip}
                onExitPip={onExitPip}
                onRequestFullscreen={onRequestFullscreen}
                onExitFullscreen={onExitFullscreen}
                displayMode={displayMode}
                onDisplayModeChange={onDisplayModeChange}
                selectedProtocolOverrideIfBothExists={
                  selectedProtocolOverrideIfBothExists
                }
                toolRenderOverrides={toolRenderOverrides}
                showSaveViewButton={showSaveViewButton}
                minimalMode={minimalMode}
                interactive={interactive}
                reasoningDisplayMode={reasoningDisplayMode}
              />
            ))}
          </div>
        )}
        {/* Text and other parts inside the bubble */}
        {(otherParts.length > 0 || fileParts.length === 0) && (
          <UserMessageBubble>
            {otherParts.map((part, i) => (
              <PartSwitch
                key={i}
                part={part}
                role={role}
                onSendFollowUp={onSendFollowUp}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={onWidgetStateChange}
                onModelContextUpdate={onModelContextUpdate}
                pipWidgetId={pipWidgetId}
                fullscreenWidgetId={fullscreenWidgetId}
                onRequestPip={onRequestPip}
                onExitPip={onExitPip}
                onRequestFullscreen={onRequestFullscreen}
                onExitFullscreen={onExitFullscreen}
                displayMode={displayMode}
                onDisplayModeChange={onDisplayModeChange}
                selectedProtocolOverrideIfBothExists={
                  selectedProtocolOverrideIfBothExists
                }
                toolRenderOverrides={toolRenderOverrides}
                showSaveViewButton={showSaveViewButton}
                minimalMode={minimalMode}
                interactive={interactive}
                reasoningDisplayMode={reasoningDisplayMode}
              />
            ))}
          </UserMessageBubble>
        )}
      </div>
    );
  }

  const steps = groupAssistantPartsIntoSteps(message.parts ?? []);
  const showClaudeFooter = claudeFooterMode !== "none";
  return (
    <article
      className={
        shouldRenderAssistantAvatar
          ? "flex w-full min-w-0 gap-4"
          : "w-full min-w-0"
      }
    >
      {shouldRenderAssistantAvatar ? (
        <div
          className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${assistantAvatar.avatarClasses}`}
          aria-label={assistantAvatar.ariaLabel}
        >
          {assistantAvatar.logoSrc ? (
            <img
              src={assistantAvatar.logoSrc}
              alt={assistantAvatar.logoAlt ?? ""}
              className="h-4 w-4 object-contain"
            />
          ) : (
            <MessageCircle
              className="h-4 w-4 text-muted-foreground"
              aria-hidden
            />
          )}
        </div>
      ) : null}

      <div className="flex-1 min-w-0">
        <div className="space-y-6 text-sm leading-6">
          {steps.map((stepParts, sIdx) => (
            <div key={sIdx} className="space-y-3">
              {stepParts.map((part, pIdx) => (
                <PartSwitch
                  key={`${sIdx}-${pIdx}`}
                  part={part}
                  role={role}
                  onSendFollowUp={onSendFollowUp}
                  toolsMetadata={toolsMetadata}
                  toolServerMap={toolServerMap}
                  onWidgetStateChange={onWidgetStateChange}
                  onModelContextUpdate={onModelContextUpdate}
                  pipWidgetId={pipWidgetId}
                  fullscreenWidgetId={fullscreenWidgetId}
                  onRequestPip={onRequestPip}
                  onExitPip={onExitPip}
                  onRequestFullscreen={onRequestFullscreen}
                  onExitFullscreen={onExitFullscreen}
                  displayMode={displayMode}
                  onDisplayModeChange={onDisplayModeChange}
                  selectedProtocolOverrideIfBothExists={
                    selectedProtocolOverrideIfBothExists
                  }
                  onToolApprovalResponse={onToolApprovalResponse}
                  messageParts={message.parts}
                  toolRenderOverrides={toolRenderOverrides}
                  showSaveViewButton={showSaveViewButton}
                  minimalMode={minimalMode}
                  interactive={interactive}
                  reasoningDisplayMode={reasoningDisplayMode}
                />
              ))}
            </div>
          ))}
        </div>
        {showClaudeFooter ? (
          <div
            data-testid={`claude-message-footer-${claudeFooterMode}`}
            className="pt-4"
          >
            <ClaudeLoadingIndicator mode={claudeFooterMode} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

export const MessageView = memo(MessageViewImpl, areMessageViewPropsEqual);

MessageView.displayName = "MessageView";
