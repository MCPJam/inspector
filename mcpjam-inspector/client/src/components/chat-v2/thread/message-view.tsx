import { memo } from "react";
import { UIMessage } from "@ai-sdk/react";
import { MessageCircle } from "lucide-react";
import type { ContentBlock } from "@modelcontextprotocol/client";

import { UserMessageBubble } from "./user-message-bubble";
import { PartSwitch } from "./part-switch";
import { ModelDefinition } from "@/shared/types";
import { type DisplayMode } from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useChatboxHostStyle,
  useChatboxHostTheme,
} from "@/contexts/chatbox-client-style-context";
import {
  groupAssistantPartsIntoSteps,
  isHiddenInternalMessage,
} from "./thread-helpers";
import { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { type ReasoningDisplayMode } from "./parts/reasoning-part";
import { ClaudeLoadingIndicator } from "@/lib/client-styles/indicators/claude-mark";
import { getAssistantAvatarDescriptor } from "@/components/chat-v2/shared/assistant-avatar";
import { SenderAvatar } from "@/components/chat-v2/shared/sender-avatar";
import type { ProjectThreadOwnerAvatar } from "@/components/chat-v2/history/project-thread-owner-avatar";
import { CopilotMessageHeader } from "./copilot-message-header";
import type { AppToolInvocationUpdate } from "./app-tool-invocations";

type ClaudeFooterMode = "none" | "animated" | "static";
type MessagePart = UIMessage["parts"][number];

interface MessageViewProps {
  chatSessionId?: string;
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
    }
  ) => void;
  onAppToolInvocationChange?: (invocation: AppToolInvocationUpdate) => void;
  pipWidgetId: string | null;
  fullscreenWidgetId: string | null;
  onRequestPip: (toolCallId: string) => void;
  onExitPip: (toolCallId: string) => void;
  onRequestFullscreen: (toolCallId: string) => void;
  onExitFullscreen: (toolCallId: string) => void;
  onRequestTeardown?: (toolCallId: string, displayWidgetId?: string) => void;
  tornDownWidgetIds?: ReadonlySet<string>;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onToolApprovalResponse?: (options: { id: string; approved: boolean }) => void;
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  showSaveViewButton?: boolean;
  minimalMode?: boolean;
  interactive?: boolean;
  reasoningDisplayMode?: ReasoningDisplayMode;
  claudeFooterMode?: ClaudeFooterMode;
  /**
   * Optional slot rendered below each user message's bubble. The host
   * (ChatTabV2) wires this when it has a persisted chat session, so a
   * per-message "Save as test case" affordance can render with access to
   * sessionId + per-message id.
   */
  renderUserMessageActions?: (message: UIMessage) => React.ReactNode;
  /**
   * Resolved sender for this message (shared sessions only). When absent, the
   * transcript renders today's identical-bubble behavior.
   */
  senderAvatar?: ProjectThreadOwnerAvatar;
  /**
   * Render the avatar above the bubble. Used by `TranscriptThread` to
   * coalesce consecutive prompts from the same sender (Slack/Linear style).
   */
  showSenderAvatar?: boolean;
}

function shouldRerenderMessage(prevMessage: UIMessage, nextMessage: UIMessage) {
  return !(
    prevMessage === nextMessage ||
    (prevMessage.id === nextMessage.id &&
      prevMessage.role === nextMessage.role &&
      prevMessage.parts === nextMessage.parts)
  );
}

function getPartKey(part: MessagePart, stepIndex: number, partIndex: number) {
  const candidate = part as {
    type?: string;
    toolCallId?: unknown;
    id?: unknown;
  };
  if (
    typeof candidate.toolCallId === "string" &&
    candidate.toolCallId.length > 0
  ) {
    return `tool-${candidate.toolCallId}`;
  }
  if (typeof candidate.id === "string" && candidate.id.length > 0) {
    return `${candidate.type ?? "part"}-${candidate.id}`;
  }
  return `${stepIndex}-${partIndex}`;
}

function isSameSenderAvatar(
  prev: ProjectThreadOwnerAvatar | undefined,
  next: ProjectThreadOwnerAvatar | undefined
) {
  if (prev === next) return true;
  if (!prev || !next) return false;
  if (prev.status !== next.status) return false;
  if (prev.status === "show" && next.status === "show") {
    return (
      prev.displayName === next.displayName && prev.imageUrl === next.imageUrl
    );
  }
  return true;
}

function areMessageViewPropsEqual(
  prev: Readonly<MessageViewProps>,
  next: Readonly<MessageViewProps>
) {
  return (
    !shouldRerenderMessage(prev.message, next.message) &&
    prev.model === next.model &&
    prev.onSendFollowUp === next.onSendFollowUp &&
    prev.toolsMetadata === next.toolsMetadata &&
    prev.chatSessionId === next.chatSessionId &&
    prev.toolServerMap === next.toolServerMap &&
    prev.onWidgetStateChange === next.onWidgetStateChange &&
    prev.onModelContextUpdate === next.onModelContextUpdate &&
    prev.onAppToolInvocationChange === next.onAppToolInvocationChange &&
    prev.pipWidgetId === next.pipWidgetId &&
    prev.fullscreenWidgetId === next.fullscreenWidgetId &&
    prev.onRequestPip === next.onRequestPip &&
    prev.onExitPip === next.onExitPip &&
    prev.onRequestFullscreen === next.onRequestFullscreen &&
    prev.onExitFullscreen === next.onExitFullscreen &&
    prev.onRequestTeardown === next.onRequestTeardown &&
    prev.tornDownWidgetIds === next.tornDownWidgetIds &&
    prev.displayMode === next.displayMode &&
    prev.onDisplayModeChange === next.onDisplayModeChange &&
    prev.onToolApprovalResponse === next.onToolApprovalResponse &&
    prev.toolRenderOverrides === next.toolRenderOverrides &&
    prev.showSaveViewButton === next.showSaveViewButton &&
    prev.minimalMode === next.minimalMode &&
    prev.interactive === next.interactive &&
    prev.reasoningDisplayMode === next.reasoningDisplayMode &&
    prev.claudeFooterMode === next.claudeFooterMode &&
    prev.renderUserMessageActions === next.renderUserMessageActions &&
    isSameSenderAvatar(prev.senderAvatar, next.senderAvatar) &&
    prev.showSenderAvatar === next.showSenderAvatar
  );
}

function MessageViewImpl({
  chatSessionId,
  message,
  model,
  onSendFollowUp,
  toolsMetadata,
  toolServerMap,
  onWidgetStateChange,
  onModelContextUpdate,
  onAppToolInvocationChange,
  pipWidgetId,
  fullscreenWidgetId,
  onRequestPip,
  onExitPip,
  onRequestFullscreen,
  onExitFullscreen,
  onRequestTeardown,
  tornDownWidgetIds,
  displayMode,
  onDisplayModeChange,
  onToolApprovalResponse,
  toolRenderOverrides,
  showSaveViewButton = true,
  minimalMode = false,
  interactive = true,
  reasoningDisplayMode = "inline",
  claudeFooterMode = "none",
  renderUserMessageActions,
  senderAvatar,
  showSenderAvatar = false,
}: MessageViewProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const chatboxHostStyle = useChatboxHostStyle();
  const chatboxHostTheme = useChatboxHostTheme();
  const assistantAvatar = getAssistantAvatarDescriptor({
    model,
    themeMode: chatboxHostTheme ?? themeMode,
    chatboxHostStyle,
  });
  const shouldRenderAssistantAvatar = chatboxHostStyle === null;
  // Copilot mimics show their own "Copilot + mascot" row above the
  // message content (faithful to real M365 Copilot's avatar/name header).
  // Other host styles keep the inspector's existing layout.
  const shouldRenderCopilotHeader = chatboxHostStyle === "copilot";
  if (isHiddenInternalMessage(message)) return null;
  const role = message.role;
  if (role !== "user" && role !== "assistant") return null;

  if (role === "user") {
    // Separate file parts from other parts - files render above the bubble
    const fileParts =
      message.parts?.filter((part) => part.type === "file") ?? [];
    const otherParts =
      message.parts?.filter((part) => part.type !== "file") ?? [];

    return (
      <div className="group/user-message flex w-full min-w-0 flex-col items-end gap-2">
        {showSenderAvatar && senderAvatar ? (
          <div className="flex max-w-[min(100%,48rem)] justify-end">
            <SenderAvatar avatar={senderAvatar} />
          </div>
        ) : null}
        {/* File attachments above the bubble */}
        {fileParts.length > 0 && (
          <div className="flex max-w-[min(100%,48rem)] flex-wrap justify-end gap-2">
            {fileParts.map((part, i) => (
              <PartSwitch
                key={`file-${i}`}
                part={part}
                role={role}
                chatSessionId={chatSessionId}
                onSendFollowUp={onSendFollowUp}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={onWidgetStateChange}
                onModelContextUpdate={onModelContextUpdate}
                onAppToolInvocationChange={onAppToolInvocationChange}
                pipWidgetId={pipWidgetId}
                fullscreenWidgetId={fullscreenWidgetId}
                onRequestPip={onRequestPip}
                onExitPip={onExitPip}
                onRequestFullscreen={onRequestFullscreen}
                onExitFullscreen={onExitFullscreen}
                onRequestTeardown={onRequestTeardown}
                tornDownWidgetIds={tornDownWidgetIds}
                displayMode={displayMode}
                onDisplayModeChange={onDisplayModeChange}
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
                chatSessionId={chatSessionId}
                onSendFollowUp={onSendFollowUp}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={onWidgetStateChange}
                onModelContextUpdate={onModelContextUpdate}
                onAppToolInvocationChange={onAppToolInvocationChange}
                pipWidgetId={pipWidgetId}
                fullscreenWidgetId={fullscreenWidgetId}
                onRequestPip={onRequestPip}
                onExitPip={onExitPip}
                onRequestFullscreen={onRequestFullscreen}
                onExitFullscreen={onExitFullscreen}
                onRequestTeardown={onRequestTeardown}
                tornDownWidgetIds={tornDownWidgetIds}
                displayMode={displayMode}
                onDisplayModeChange={onDisplayModeChange}
                toolRenderOverrides={toolRenderOverrides}
                showSaveViewButton={showSaveViewButton}
                minimalMode={minimalMode}
                interactive={interactive}
                reasoningDisplayMode={reasoningDisplayMode}
              />
            ))}
          </UserMessageBubble>
        )}
        {renderUserMessageActions ? (
          <div className="flex max-w-[min(100%,48rem)] justify-end gap-1 opacity-0 transition-opacity duration-150 group-hover/user-message:opacity-100 focus-within:opacity-100">
            {renderUserMessageActions(message)}
          </div>
        ) : null}
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
        {shouldRenderCopilotHeader ? (
          <div className="mb-2">
            <CopilotMessageHeader />
          </div>
        ) : null}
        <div className="space-y-6 text-sm leading-6">
          {steps.map((stepParts, sIdx) => (
            <div key={sIdx} className="space-y-3">
              {stepParts.map((part, pIdx) => (
                <PartSwitch
                  key={getPartKey(part, sIdx, pIdx)}
                  part={part}
                  role={role}
                  chatSessionId={chatSessionId}
                  onSendFollowUp={onSendFollowUp}
                  toolsMetadata={toolsMetadata}
                  toolServerMap={toolServerMap}
                  onWidgetStateChange={onWidgetStateChange}
                  onModelContextUpdate={onModelContextUpdate}
                  onAppToolInvocationChange={onAppToolInvocationChange}
                  pipWidgetId={pipWidgetId}
                  fullscreenWidgetId={fullscreenWidgetId}
                  onRequestPip={onRequestPip}
                  onExitPip={onExitPip}
                  onRequestFullscreen={onRequestFullscreen}
                  onExitFullscreen={onExitFullscreen}
                  onRequestTeardown={onRequestTeardown}
                  tornDownWidgetIds={tornDownWidgetIds}
                  displayMode={displayMode}
                  onDisplayModeChange={onDisplayModeChange}
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
