export type HostedRuntimeContext = {
  projectId?: string | null;
  selectedServerIds?: string[];
  oauthTokens?: Record<string, string>;
  chatboxToken?: string;
  chatboxSurface?: "preview" | "share_link";
};
