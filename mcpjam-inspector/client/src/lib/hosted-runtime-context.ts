export type HostedRuntimeContext = {
  workspaceId?: string | null;
  selectedServerIds?: string[];
  oauthTokens?: Record<string, string>;
  shareToken?: string;
  chatboxToken?: string;
  chatboxSurface?: "preview" | "share_link";
};
