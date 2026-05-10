export type HostedRuntimeContext = {
  projectId?: string | null;
  selectedServerIds?: string[];
  oauthTokens?: Record<string, string>;
  /**
   * Post-refactor chatbox identifiers (set after /web/chatbox/redeem).
   * `chatboxToken` is retained for surfaces that haven't migrated; the
   * server prefers `chatboxId` when both are present.
   */
  chatboxId?: string;
  accessVersion?: number;
  chatboxToken?: string;
  chatboxSurface?: "preview" | "share_link";
};
