import { MCPServerConfig } from "@mcpjam/sdk";
import { OauthTokens } from "@/shared/types.js";
import type { OAuthTestProfile } from "@/lib/oauth/profile";

export type ConnectionStatus =
  | "connected"
  | "connecting"
  | "failed"
  | "disconnected"
  | "oauth-flow";

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
  id: string;
  name: string;
  config: MCPServerConfig;
  oauthTokens?: OauthTokens;
  oauthFlowProfile?: OAuthTestProfile;
  initializationInfo?: InitializationInfo;
  lastConnectionTime: Date;
  connectionStatus: ConnectionStatus;
  retryCount: number;
  lastError?: string;
  enabled?: boolean;
  /** Whether OAuth is explicitly enabled for this server. When false, reconnect skips OAuth flow. */
  useOAuth?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  servers: Record<string, ServerWithName>;
  createdAt: Date;
  updatedAt: Date;
  isDefault?: boolean;
  sharedWorkspaceId?: string;
}

export interface AppState {
  workspaces: Record<string, Workspace>;
  activeWorkspaceId: string;
  servers: Record<string, ServerWithName>;
  selectedServer: string;
  selectedMultipleServers: string[]; // Stores server ids
  isMultiSelectMode: boolean;
}

export type AgentServerInfo = { id: string; status: ConnectionStatus };

export type AppAction =
  | { type: "HYDRATE_STATE"; payload: AppState }
  | { type: "UPSERT_SERVER"; server: ServerWithName }
  | { type: "RENAME_SERVER"; id: string; newName: string }
  | {
      type: "CONNECT_REQUEST";
      id: string;
      name: string;
      config: MCPServerConfig;
      select?: boolean;
    }
  | {
      type: "CONNECT_SUCCESS";
      id: string;
      name: string;
      config: MCPServerConfig;
      tokens?: OauthTokens;
    }
  | { type: "CONNECT_FAILURE"; id: string; error: string }
  | { type: "RECONNECT_REQUEST"; id: string; config: MCPServerConfig }
  | { type: "DISCONNECT"; id: string; error?: string }
  | { type: "REMOVE_SERVER"; id: string }
  | { type: "SYNC_AGENT_STATUS"; servers: AgentServerInfo[] }
  | { type: "SELECT_SERVER"; id: string }
  | { type: "SET_MULTI_SELECTED"; ids: string[] }
  | { type: "SET_MULTI_MODE"; enabled: boolean }
  | {
      type: "SET_INITIALIZATION_INFO";
      id: string;
      initInfo: InitializationInfo;
    }
  | { type: "CREATE_WORKSPACE"; workspace: Workspace }
  | {
      type: "UPDATE_WORKSPACE";
      workspaceId: string;
      updates: Partial<Workspace>;
    }
  | { type: "DELETE_WORKSPACE"; workspaceId: string }
  | { type: "SWITCH_WORKSPACE"; workspaceId: string }
  | { type: "SET_DEFAULT_WORKSPACE"; workspaceId: string }
  | { type: "IMPORT_WORKSPACE"; workspace: Workspace }
  | { type: "DUPLICATE_WORKSPACE"; workspaceId: string; newName: string };

export const initialAppState: AppState = {
  workspaces: {
    default: {
      id: "default",
      name: "Default",
      description: "Default workspace",
      servers: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      isDefault: true,
    },
  },
  activeWorkspaceId: "default",
  servers: {},
  selectedServer: "none",
  selectedMultipleServers: [],
  isMultiSelectMode: false,
};
