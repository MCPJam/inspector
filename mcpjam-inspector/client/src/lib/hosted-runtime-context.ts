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
};
