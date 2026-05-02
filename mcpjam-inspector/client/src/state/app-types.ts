import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import { OauthTokens } from "@/shared/types.js";
import type { OAuthTestProfile } from "@/lib/oauth/profile";
import type { ProjectClientConfig } from "@/lib/client-config";
import type { OAuthTrace } from "@/lib/oauth/oauth-trace";

export type ConnectionStatus =
  | "connected"
  | "connecting"
  | "failed"
  | "disconnected"
  | "oauth-flow";

export type ProjectVisibility = "public" | "private";

export interface InitializationInfo {
  protocolVersion?: string;
  transport?: string;
  serverCapabilities?: Record<string, any>;
  serverVersion?: {
    name: string;
    version: string;
    title?: string;
    websiteUrl?: string;
    icons?: Array<{
      src: string;
      mimeType?: string;
      sizes?: string[];
    }>;
  };
  instructions?: string;
  clientCapabilities?: Record<string, any>;
}

export interface ServerWithName {
  name: string;
  config: MCPServerConfig;
  oauthTokens?: OauthTokens;
  oauthFlowProfile?: OAuthTestProfile;
  initializationInfo?: InitializationInfo;
  lastConnectionTime: Date;
  connectionStatus: ConnectionStatus;
  retryCount: number;
  lastError?: string;
  lastOAuthTrace?: OAuthTrace;
  enabled?: boolean;
  /** Whether OAuth is explicitly enabled for this server. When false, reconnect skips OAuth flow. */
  useOAuth?: boolean;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  clientConfig?: ProjectClientConfig;
  servers: Record<string, ServerWithName>;
  createdAt: Date;
  updatedAt: Date;
  canDeleteProject?: boolean;
  isDefault?: boolean;
  sharedProjectId?: string;
  organizationId?: string;
  visibility?: ProjectVisibility;
}

export interface AppState {
  projects: Record<string, Project>;
  activeProjectId: string;
  servers: Record<string, ServerWithName>;
  selectedServer: string;
  selectedMultipleServers: string[];
  isMultiSelectMode: boolean;
}

export type AgentServerInfo = {
  id: string;
  status: ConnectionStatus;
  config?: MCPServerConfig;
};

export type AppAction =
  | { type: "HYDRATE_STATE"; payload: AppState }
  | { type: "UPSERT_SERVER"; name: string; server: ServerWithName }
  | {
      type: "CONNECT_REQUEST";
      name: string;
      config: MCPServerConfig;
      select?: boolean;
    }
  | {
      type: "CONNECT_SUCCESS";
      name: string;
      config: MCPServerConfig;
      tokens?: OauthTokens;
      useOAuth?: boolean;
      oauthTrace?: OAuthTrace;
    }
  | {
      type: "CONNECT_FAILURE";
      name: string;
      error: string;
      oauthTrace?: OAuthTrace;
    }
  | {
      type: "RECONNECT_REQUEST";
      name: string;
      config: MCPServerConfig;
      select?: boolean;
    }
  | { type: "DISCONNECT"; name: string; error?: string }
  | { type: "REMOVE_SERVER"; name: string }
  | { type: "SYNC_AGENT_STATUS"; servers: AgentServerInfo[] }
  | { type: "SELECT_SERVER"; name: string }
  | { type: "SET_MULTI_SELECTED"; names: string[] }
  | { type: "SET_MULTI_MODE"; enabled: boolean }
  | {
      type: "SET_INITIALIZATION_INFO";
      name: string;
      initInfo: InitializationInfo;
    }
  | {
      type: "SET_SERVER_OAUTH_TRACE";
      name: string;
      oauthTrace?: OAuthTrace;
    }
  | { type: "CREATE_PROJECT"; project: Project }
  | {
      type: "UPDATE_PROJECT";
      projectId: string;
      updates: Partial<Project>;
    }
  | { type: "DELETE_PROJECT"; projectId: string }
  | { type: "SWITCH_PROJECT"; projectId: string }
  | { type: "SET_DEFAULT_PROJECT"; projectId: string }
  | { type: "IMPORT_PROJECT"; project: Project }
  | { type: "DUPLICATE_PROJECT"; projectId: string; newName: string };

export const initialAppState: AppState = {
  projects: {
    default: {
      id: "default",
      name: "Default",
      description: "Default project",
      servers: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      isDefault: true,
    },
  },
  activeProjectId: "default",
  servers: {},
  selectedServer: "none",
  selectedMultipleServers: [],
  isMultiSelectMode: false,
};
