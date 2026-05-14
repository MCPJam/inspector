import { Hammer, History } from "lucide-react";
import { createElement } from "react";
import type { PaneDescriptor, PaneId } from "./types";
import { MultiServerToolsPane } from "./MultiServerToolsPane";
import { ChatHistoryRail } from "@/components/chat-v2/history/ChatHistoryRail";
import { usePlaygroundChatHistoryBridge } from "@/components/playground/playground-chat-history-bridge";

/**
 * Playground pane registry.
 *
 * `PaneSlot` skips any pane id it can't resolve in the registry, so a payload
 * referencing an unregistered id (e.g. an old saved view referencing a pane
 * that no longer exists) renders cleanly rather than throwing.
 *
 * - `tools`: renders the legacy `PlaygroundLeft` (tool list + parameters form
 *   + saved requests + logger) using state from `useAppBuilderStateContext`.
 *   This makes the docked tools pane behaviorally identical to the App Builder
 *   left sidebar — the multi-server-aware `ToolsPane` (display-only today)
 *   takes over once `useAppBuilderState` is extended to multi-server.
 * - `chatHistory`: renders the `ChatHistoryRail` from chat-v2 via a bridge
 *   `PlaygroundMain` publishes (it owns the chat session and history
 *   handlers). When PlaygroundMain hasn't mounted yet, a placeholder shows
 *   instead — usually only visible for one frame.
 * - `header`: layout-only concept, not a movable pane; not registered.
 */
const REGISTRY = new Map<PaneId, PaneDescriptor>();

REGISTRY.set("tools", {
  id: "tools",
  title: "Tools",
  icon: Hammer,
  defaultSide: "left",
  renderBody: () => createElement(MultiServerToolsPane),
});

REGISTRY.set("chatHistory", {
  id: "chatHistory",
  title: "Chat History",
  icon: History,
  defaultSide: "left",
  renderBody: () => createElement(ChatHistoryPaneFromBridge),
});

function ChatHistoryPaneFromBridge() {
  const bridge = usePlaygroundChatHistoryBridge();
  if (!bridge) {
    return createElement(
      "div",
      {
        className:
          "flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground",
      },
      "Loading chat history…",
    );
  }
  return createElement(ChatHistoryRail, {
    activeSessionId: bridge.activeSessionId,
    hostStyle: bridge.hostStyle,
    isAuthenticated: bridge.isAuthenticated,
    isStreaming: bridge.isStreaming,
    sharedThreadsEnabled: bridge.sharedThreadsEnabled,
    projectId: bridge.projectId,
    enabled: bridge.enabled,
    refreshSignal: bridge.refreshSignal,
    onSelectThread: bridge.onSelectThread,
    onPrefetchThread: bridge.onPrefetchThread,
    onNewChat: bridge.onNewChat,
    beforeResetChatAfterArchiveAll: bridge.beforeResetChatAfterArchiveAll,
    onArchiveAllComplete: bridge.onArchiveAllComplete,
    onSessionAction: bridge.onSessionAction,
  });
}

export function getPane(id: PaneId): PaneDescriptor | undefined {
  return REGISTRY.get(id);
}

export function listPanes(): PaneDescriptor[] {
  return Array.from(REGISTRY.values());
}
