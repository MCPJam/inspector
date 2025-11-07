import { MCPServerConfig } from "@/sdk";
import { OauthTokens } from "@/shared/types.js";

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
  };
  instructions?: string;
  clientCapabilities?: Record<string, any>;
}

export interface ServerWithName {
  name: string;
  config: MCPServerConfig;
  oauthTokens?: OauthTokens;
  initializationInfo?: InitializationInfo;
  lastConnectionTime: Date;
  connectionStatus: ConnectionStatus;
  retryCount: number;
  lastError?: string;
  enabled?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  servers: Record<string, ServerWithName>;
  createdAt: Date;
  updatedAt: Date;
  isDefault?: boolean;
}

export interface AppState {
  workspaces: Record<string, Workspace>;
  activeWorkspaceId: string;
  servers: Record<string, ServerWithName>;
  selectedServer: string;
  selectedMultipleServers: string[];
  isMultiSelectMode: boolean;
}

export type AgentServerInfo = { id: string; status: ConnectionStatus };

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
    }
  | { type: "CONNECT_FAILURE"; name: string; error: string }
  | { type: "RECONNECT_REQUEST"; name: string }
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
