import { MCPServerConfig } from "@mcpjam/sdk";
import { OauthTokens } from "@/shared/types.js";
import type { OAuthTestProfile } from "@/lib/oauth/profile";

/** Branded type for server IDs — prevents accidental use of server names as keys. */
export type ServerId = string & { readonly __brand: "ServerId" };
/** Cast a plain string to ServerId at creation/deserialization boundaries. */
export const toServerId = (id: string) => id as ServerId;

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
  id: ServerId;
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
  servers: Record<ServerId, ServerWithName>;
  createdAt: Date;
  updatedAt: Date;
  isDefault?: boolean;
  sharedWorkspaceId?: string;
}

export interface AppState {
  workspaces: Record<string, Workspace>;
  activeWorkspaceId: string;
  servers: Record<ServerId, ServerWithName>;
  selectedServer: ServerId;
  selectedMultipleServers: ServerId[];
  isMultiSelectMode: boolean;
}

export type AgentServerInfo = { id: ServerId; status: ConnectionStatus };

export type AppAction =
  | { type: "HYDRATE_STATE"; payload: AppState }
  | { type: "UPSERT_SERVER"; server: ServerWithName }
  | { type: "RENAME_SERVER"; id: ServerId; newName: string }
  | {
      type: "CONNECT_REQUEST";
      id: ServerId;
      name: string;
      config: MCPServerConfig;
      select?: boolean;
    }
  | {
      type: "CONNECT_SUCCESS";
      id: ServerId;
      name: string;
      config: MCPServerConfig;
      tokens?: OauthTokens;
    }
  | { type: "CONNECT_FAILURE"; id: ServerId; error: string }
  | { type: "RECONNECT_REQUEST"; id: ServerId; config: MCPServerConfig }
  | { type: "DISCONNECT"; id: ServerId; error?: string }
  | { type: "REMOVE_SERVER"; id: ServerId }
  | { type: "SYNC_AGENT_STATUS"; servers: AgentServerInfo[] }
  | { type: "SELECT_SERVER"; id: ServerId }
  | { type: "SET_MULTI_SELECTED"; ids: ServerId[] }
  | { type: "SET_MULTI_MODE"; enabled: boolean }
  | {
      type: "SET_INITIALIZATION_INFO";
      id: ServerId;
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
  selectedServer: toServerId("none"),
  selectedMultipleServers: [],
  isMultiSelectMode: false,
};
