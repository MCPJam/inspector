/**
 * Playground chat-history bridge
 *
 * `PlaygroundMain` owns the chat session (selected model, draft state, history
 * coordination); the docked `chatHistory` pane lives outside that subtree.
 * Rather than restructure PlaygroundMain to lift chat-session state up, we
 * publish a small bridge object here and the docked pane subscribes.
 *
 * The bridge is replaced whole (rather than diffed) so React's referential
 * equality flips on every dependency change inside PlaygroundMain. Callers
 * should hold the bridge in a single selector; component unmount clears it
 * to null so a stale pane doesn't render after the Playground unmounts.
 */
import { create } from "zustand";
import type { ChatHistorySession } from "@/lib/apis/web/chat-history-api";
import type { ChatboxHostStyle } from "@/lib/chatbox-client-style";

export interface PlaygroundChatHistoryBridge {
  activeSessionId: string | null;
  hostStyle: ChatboxHostStyle | undefined;
  isAuthenticated: boolean;
  isStreaming: boolean;
  projectId: string | null | undefined;
  enabled: boolean;
  refreshSignal: number;
  onSelectThread: (session: ChatHistorySession) => void | Promise<void>;
  /** Hover prefetch — warms detail + blob caches so click is near-instant. */
  onPrefetchThread?: (session: ChatHistorySession) => void;
  onNewChat: (options?: { shared?: boolean }) => void | Promise<void>;
  beforeResetChatAfterArchiveAll?: () => boolean | Promise<boolean>;
  onArchiveAllComplete?: (hadActiveHistorySelection: boolean) => void;
  onSessionAction?: (event: {
    action:
      | "rename"
      | "archive"
      | "unarchive"
      | "share"
      | "unshare"
      | "pin"
      | "unpin";
    session: ChatHistorySession;
  }) => void | Promise<void>;
}

interface BridgeStore {
  bridge: PlaygroundChatHistoryBridge | null;
  setBridge: (bridge: PlaygroundChatHistoryBridge | null) => void;
}

export const usePlaygroundChatHistoryBridgeStore = create<BridgeStore>(
  (set) => ({
    bridge: null,
    setBridge: (bridge) => set({ bridge }),
  }),
);

/** Selector hook for pane consumers. */
export function usePlaygroundChatHistoryBridge():
  | PlaygroundChatHistoryBridge
  | null {
  return usePlaygroundChatHistoryBridgeStore((s) => s.bridge);
}
