export type ServerStatus = "reachable" | "unreachable" | "skipped" | "error";

export type ServerTransportType = "http" | "stdio";

export type ServerInfo = {
  name?: string;
  version?: string;
};

export type ServerEntry = {
  id: string;
  name: string;
  transportType: ServerTransportType;
  url?: string;
  status: ServerStatus;
  statusDetail?: string;
  serverInfo?: ServerInfo;
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
