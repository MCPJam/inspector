/**
 * Registry server documents and workspace connections (Convex / catalog variants).
 */

export interface RegistryServer {
  _id: string;
  // Identity
  name: string;
  displayName: string;
  description?: string;
  iconUrl?: string;
  publishStatus?: "verified" | "unverified";
  clientType?: "text" | "app";
  scope: "global" | "organization";
  organizationId?: string;
  transport: {
    transportType: "stdio" | "http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    useOAuth?: boolean;
    oauthScopes?: string[];
    oauthCredentialKey?: string;
    clientId?: string;
    timeout?: number;
  };
  category?: string;
  tags?: string[];
  version?: string;
  publisher?: string;
  repositoryUrl?: string;
  sortOrder?: number;
  status: "approved" | "pending_review" | "deprecated";
  meta?: unknown;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface RegistryServerConnection {
  _id: string;
  registryServerId: string;
  workspaceId: string;
  serverId: string;
  connectedBy: string;
  connectedAt: number;
  configOverridden?: boolean;
}
