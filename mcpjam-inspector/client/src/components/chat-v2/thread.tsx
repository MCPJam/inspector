import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import {
  useChatboxHostStyle,
  useChatboxHostTheme,
} from "@/contexts/chatbox-client-style-context";
import { UIMessage } from "@ai-sdk/react";
import type { ContentBlock } from "@modelcontextprotocol/client";
import type { TranscriptThreadProps } from "./thread/transcript-thread";

import { ModelDefinition } from "@/shared/types";
import { type DisplayMode } from "@/stores/ui-playground-store";
import { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { ThinkingIndicator } from "@/components/chat-v2/shared/thinking-indicator";
import { FullscreenChatOverlay } from "@/components/chat-v2/fullscreen-chat-overlay";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { useResolvedHostStyleForIndicator } from "@/components/chat-v2/shared/loading-indicator-content";
import {
  getChatboxChatBackground,
  getChatboxHostFamily,
} from "@/lib/chatbox-client-style";
import { type ReasoningDisplayMode } from "./thread/parts/reasoning-part";
import { TranscriptThread } from "./thread/transcript-thread";
import {
  getLastRenderableConversationMessage,
  hasRenderableConversationContent,
} from "./thread/thread-helpers";
import {
  WidgetSurfaceHost,
  WidgetSurfaceHostProvider,
} from "./thread/mcp-apps/widget-surface-host";
import { InspectorWidgetHostProvider } from "./thread/mcp-apps/use-widget-host";
import { useWidgetSurfaceStore } from "./thread/mcp-apps/widget-surface-store";
import type {
  AppToolInvocation,
  AppToolInvocationUpdate,
} from "./thread/app-tool-invocations";

interface ThreadProps {
  chatSessionId?: string;
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
    }
  ) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onFullscreenChange?: (isFullscreen: boolean) => void;
  enableFullscreenChatOverlay?: boolean;
  fullscreenChatPlaceholder?: string;
  fullscreenChatDisabled?: boolean;
  fullscreenChatSendBlocked?: boolean;
  onFullscreenChatStop?: () => void;
  onToolApprovalResponse?: (options: { id: string; approved: boolean }) => void;
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  showSaveViewButton?: boolean;
  minimalMode?: boolean;
  interactive?: boolean;
  reasoningDisplayMode?: ReasoningDisplayMode;
  mcpToolResultImageRendering?: "none" | "panel" | "inline";
  focusMessageId?: string | null;
  highlightedMessageIds?: string[];
  navigationKey?: string | number | null;
  viewportRef?: RefObject<HTMLElement | null>;
  contentClassName?: string;
  getMessageWrapperProps?: TranscriptThreadProps["getMessageWrapperProps"];
  /**
   * Optional slot rendered below each user message's bubble. ChatTabV2 wires
   * this with a "Save as test case" affordance when a persisted chat session
   * is active; other consumers can omit it.
   */
  renderUserMessageActions?: TranscriptThreadProps["renderUserMessageActions"];
  /**
   * Per-message sender attribution in shared sessions. Both must be supplied
   * for avatars to render; otherwise the transcript looks identical to today.
   */
  showSenderAvatars?: TranscriptThreadProps["showSenderAvatars"];
  resolveSenderAvatar?: TranscriptThreadProps["resolveSenderAvatar"];
  /** Tier 3 recorder bundle, forwarded to TranscriptThread (default off). */
  recorder?: TranscriptThreadProps["recorder"];
  /**
   * Frozen-replay override for `appToolInvocations`. When set (eval Chat tab),
   * these reconstructed-from-trace invocations are rendered instead of the live
   * host-bridge state — a completed run can't re-fire the bridge. Leave
   * `undefined` on the live Playground/chat path so behavior is byte-identical.
   */
  appToolInvocationsOverride?: AppToolInvocation[];
}

function getWidgetOwnershipIds(toolCallId: string, displayWidgetId?: string) {
  const ids = new Set<string>([toolCallId]);
  if (displayWidgetId) ids.add(displayWidgetId);

  const surfaces = useWidgetSurfaceStore.getState().surfaces;
  const surface =
    surfaces.get(displayWidgetId ?? "") ?? surfaces.get(toolCallId);
  if (surface) {
    for (const registeredToolCallId of surface.registrations.keys()) {
      ids.add(registeredToolCallId);
    }
  }

  return ids;
}

function getMessageToolCallIds(messages: UIMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const toolCallId = (part as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId === "string" && toolCallId.length > 0) {
        ids.add(toolCallId);
      }
    }
  }
  return ids;
}

export function Thread({
  chatSessionId,
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
  onToolApprovalResponse,
  toolRenderOverrides,
  showSaveViewButton = true,
  minimalMode = false,
  interactive = true,
  reasoningDisplayMode = "inline",
  mcpToolResultImageRendering = "inline",
  focusMessageId = null,
  highlightedMessageIds = [],
  navigationKey = null,
  viewportRef,
  contentClassName,
  getMessageWrapperProps,
  renderUserMessageActions,
  showSenderAvatars,
  resolveSenderAvatar,
  recorder,
  appToolInvocationsOverride,
}: ThreadProps) {
  const [pipWidgetId, setPipWidgetId] = useState<string | null>(null);
  const [fullscreenWidgetId, setFullscreenWidgetId] = useState<string | null>(
    null
  );
  const [tornDownWidgetIds, setTornDownWidgetIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [isFullscreenChatOpen, setIsFullscreenChatOpen] = useState(false);
  const [fullscreenChatInput, setFullscreenChatInput] = useState("");
  const [appToolInvocations, setAppToolInvocations] = useState<
    AppToolInvocation[]
  >([]);

  const handleAppToolInvocationChange = useCallback(
    (invocation: AppToolInvocationUpdate) => {
      setAppToolInvocations((current) => {
        const index = current.findIndex((item) => item.id === invocation.id);
        if (index === -1) {
          return [...current, invocation];
        }
        const next = [...current];
        next[index] = invocation;
        return next;
      });
    },
    []
  );

  useEffect(() => {
    setAppToolInvocations([]);
  }, [chatSessionId]);

  useEffect(() => {
    const liveToolCallIds = getMessageToolCallIds(messages);
    setAppToolInvocations((current) => {
      const next = current.filter((invocation) =>
        liveToolCallIds.has(invocation.parentToolCallId)
      );
      return next.length === current.length ? current : next;
    });
  }, [messages]);

  const handleRequestPip = (toolCallId: string) => {
    setPipWidgetId(toolCallId);
  };

  const handleExitPip = (toolCallId: string) => {
    const ownershipIds = getWidgetOwnershipIds(toolCallId);
    if (pipWidgetId !== null && ownershipIds.has(pipWidgetId)) {
      setPipWidgetId(null);
    }
  };

  const handleRequestFullscreen = (toolCallId: string) => {
    setFullscreenWidgetId(toolCallId);
    onFullscreenChange?.(true);
  };

  const handleExitFullscreen = (toolCallId: string) => {
    const ownershipIds = getWidgetOwnershipIds(toolCallId);
    if (fullscreenWidgetId !== null && ownershipIds.has(fullscreenWidgetId)) {
      setFullscreenWidgetId(null);
      onFullscreenChange?.(false);
    }
  };

  const handleRequestTeardown = useCallback(
    (toolCallId: string, displayWidgetId?: string) => {
      const ownershipIds = getWidgetOwnershipIds(toolCallId, displayWidgetId);
      setTornDownWidgetIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const id of ownershipIds) {
          if (next.has(id)) continue;
          next.add(id);
          changed = true;
        }
        return changed ? next : prev;
      });
      // Mirror `handleExitPip` / `handleExitFullscreen`: if the widget that
      // asked for teardown was the one currently in PIP or fullscreen, clear
      // that state too. Persistent surfaces claim fullscreen/PiP under
      // `displayWidgetId` (the surface id), but `tornDownWidgetIds` is keyed
      // by tool-call ids — expand the surface to all active registrations so
      // the old row cannot keep the shared iframe alive after teardown.
      const matchesOwnership = (current: string | null) =>
        current !== null && ownershipIds.has(current);
      setPipWidgetId((current) => (matchesOwnership(current) ? null : current));
      // Keep the updater pure (StrictMode double-invokes); fire the
      // fullscreen callback once, outside, based on the same ownership check.
      const clearedFullscreen = matchesOwnership(fullscreenWidgetId);
      setFullscreenWidgetId((current) =>
        matchesOwnership(current) ? null : current
      );
      if (clearedFullscreen) {
        onFullscreenChange?.(false);
      }
      if (matchesOwnership(pipWidgetId) || clearedFullscreen) {
        onDisplayModeChange?.("inline");
      }
    },
    [fullscreenWidgetId, onDisplayModeChange, onFullscreenChange, pipWidgetId]
  );

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

  const chatboxHostStyle = useChatboxHostStyle();
  const chatboxHostTheme = useChatboxHostTheme();
  const hasBrandIndicator =
    useResolvedHostStyleForIndicator(model.provider) !== null;
  const isChatgptDark =
    getChatboxHostFamily(chatboxHostStyle) === "chatgpt" &&
    chatboxHostTheme === "dark";
  const lastRenderableMessage = useMemo(
    () => getLastRenderableConversationMessage(messages),
    [messages]
  );
  const hasVisibleAssistantResponse =
    lastRenderableMessage?.role === "assistant" &&
    hasRenderableConversationContent(lastRenderableMessage);
  const lastRenderableMessageId = hasVisibleAssistantResponse
    ? lastRenderableMessage.id
    : null;
  const shouldShowStandaloneThinkingIndicator = hasBrandIndicator
    ? isLoading && !hasVisibleAssistantResponse
    : isLoading;

  // Source the dark chatgpt-family chat surface from the registry
  // (built-ins) so every consumer sees the same color per host+theme.
  // Built-ins already owns: ChatGPT #212121, Copilot #303030,
  // Cursor #1f1f1f. Leaves the `isChatgptDark` gating unchanged so we
  // don't paint a background where one wasn't painted before.
  const chatgptFamilyDarkBackground = isChatgptDark
    ? getChatboxChatBackground(chatboxHostStyle, "dark")
    : undefined;

  return (
    <WidgetSurfaceHostProvider>
      <div
        className={cn(
          "flex-1 min-h-0 min-w-0 pb-4",
          isChatgptDark && "text-[#DFDFDF]"
        )}
        style={
          chatgptFamilyDarkBackground
            ? { backgroundColor: chatgptFamilyDarkBackground }
            : undefined
        }
      >
        {/* Fixed spacer to reserve space for PIP widget */}
        {pipWidgetId && (
          <div className="h-[480px] flex-shrink-0 pointer-events-none" />
        )}
        <TranscriptThread
          chatSessionId={chatSessionId}
          messages={messages}
          model={model}
          sendFollowUpMessage={sendFollowUpMessage}
          toolsMetadata={toolsMetadata}
          toolServerMap={toolServerMap}
          onWidgetStateChange={onWidgetStateChange}
          onModelContextUpdate={onModelContextUpdate}
          appToolInvocations={appToolInvocationsOverride ?? appToolInvocations}
          onAppToolInvocationChange={handleAppToolInvocationChange}
          pipWidgetId={pipWidgetId}
          fullscreenWidgetId={fullscreenWidgetId}
          onRequestPip={handleRequestPip}
          onExitPip={handleExitPip}
          onRequestFullscreen={handleRequestFullscreen}
          onExitFullscreen={handleExitFullscreen}
          onRequestTeardown={handleRequestTeardown}
          tornDownWidgetIds={tornDownWidgetIds}
          displayMode={displayMode}
          onDisplayModeChange={onDisplayModeChange}
          onToolApprovalResponse={onToolApprovalResponse}
          toolRenderOverrides={toolRenderOverrides}
          showSaveViewButton={showSaveViewButton}
          minimalMode={minimalMode}
          interactive={interactive}
          reasoningDisplayMode={reasoningDisplayMode}
          mcpToolResultImageRendering={mcpToolResultImageRendering}
          focusMessageId={focusMessageId}
          highlightedMessageIds={highlightedMessageIds}
          navigationKey={navigationKey}
          viewportRef={viewportRef}
          isLoading={isLoading}
          lastRenderableMessageId={lastRenderableMessageId}
          contentClassName={
            contentClassName ??
            "min-w-0 w-full max-w-4xl mx-auto px-4 pt-8 pb-16 space-y-8"
          }
          getMessageWrapperProps={getMessageWrapperProps}
          renderUserMessageActions={renderUserMessageActions}
          showSenderAvatars={showSenderAvatars}
          resolveSenderAvatar={resolveSenderAvatar}
          recorder={recorder}
        />
        <InspectorWidgetHostProvider>
          <WidgetSurfaceHost chatSessionId={chatSessionId} />
        </InspectorWidgetHostProvider>

        {shouldShowStandaloneThinkingIndicator && (
          <div className="min-w-0 w-full max-w-4xl mx-auto px-4">
            <ThinkingIndicator model={model} />
          </div>
        )}

        {showFullscreenChatOverlay && (
          <FullscreenChatOverlay
            chatSessionId={chatSessionId}
            messages={messages}
            modelProvider={model.provider}
            open={isFullscreenChatOpen}
            onOpenChange={setIsFullscreenChatOpen}
            input={fullscreenChatInput}
            onInputChange={setFullscreenChatInput}
            placeholder={fullscreenChatPlaceholder}
            disabled={fullscreenChatDisabled}
            canSend={canSendFullscreenChat}
            isThinking={isLoading}
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
    </WidgetSurfaceHostProvider>
  );
}
