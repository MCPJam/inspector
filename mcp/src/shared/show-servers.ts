export type ServerStatus = "reachable" | "unreachable" | "skipped" | "error";

export type ServerTransportType = "http" | "stdio";

export type ServerInfo = {
  name?: string;
  version?: string;
};

export type ServerPrimitiveListStatus = "loaded" | "skipped" | "error";

export type ServerPrimitiveCollection<TItem> = {
  status: ServerPrimitiveListStatus;
  items: TItem[];
  statusDetail?: string;
};

export type ServerToolInfo = {
  name: string;
  title?: string;
  description?: string;
};

export type ServerResourceInfo = {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

export type ServerPromptArgumentInfo = {
  name: string;
  description?: string;
  required?: boolean;
};

export type ServerPromptInfo = {
  name: string;
  title?: string;
  description?: string;
  arguments?: ServerPromptArgumentInfo[];
};

export type ServerPrimitives = {
  tools: ServerPrimitiveCollection<ServerToolInfo>;
  resources: ServerPrimitiveCollection<ServerResourceInfo>;
  prompts: ServerPrimitiveCollection<ServerPromptInfo>;
};

export type ServerEntry = {
  id: string;
  name: string;
  transportType: ServerTransportType;
  url?: string;
  status: ServerStatus;
  statusDetail?: string;
  serverInfo?: ServerInfo;
  primitives?: ServerPrimitives;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
};

export type SelectedWorkspaceInfo = WorkspaceInfo & {
  organizationId: string;
};

export type ShowServersSummary = Record<ServerStatus, number>;

export type ShowServersPayload = {
  workspace: SelectedWorkspaceInfo;
  servers: ServerEntry[];
  otherWorkspaces: WorkspaceInfo[];
  summary: ShowServersSummary;
  generatedAt: string;
};
