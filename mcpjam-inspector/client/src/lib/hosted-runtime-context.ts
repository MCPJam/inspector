export type HostedRuntimeContext = {
  projectId?: string | null;
  selectedServerIds?: string[];
  oauthTokens?: Record<string, string>;
  /**
   * Resolved chatbox identity (post-redeem). Threaded into every
   * chatbox-aware request body and cache key.
   */
  chatboxId?: string;
  accessVersion?: number;
  chatboxSurface?: "preview" | "share_link";
  /**
   * Silent re-redeem trigger. Called when a chatbox-aware Convex mutation
   * reports `chatbox_access_stale` — the owner re-runs
   * /web/chatbox/redeem and updates `accessVersion` in place so dependent
   * flows can retry without a page reload.
   */
  requestRefreshAccessVersion?: () => void;
  /**
   * True for published-chatbox runtime sessions (bootstrapped via
   * /api/web/chatboxes/redeem). Their server set is Convex-resolved by
   * id, so the turn must flow through /api/web/chat-v2 (with authFetch)
   * on every platform — the local /api/mcp engine has no way to connect
   * attachment servers and would silently run the chat without tools.
   * Playground builder previews stay platform-routed: in local mode they
   * reuse the builder's locally-connected servers.
   */
  requiresWebChatApi?: boolean;
};
