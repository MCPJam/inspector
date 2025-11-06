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

export interface Profile {
  id: string;
  name: string;
  description?: string;
  servers: Record<string, ServerWithName>;
  createdAt: Date;
  updatedAt: Date;
  isDefault?: boolean;
}

export interface AppState {
  profiles: Record<string, Profile>;
  activeProfileId: string;
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
  | { type: "CREATE_PROFILE"; profile: Profile }
  | { type: "UPDATE_PROFILE"; profileId: string; updates: Partial<Profile> }
  | { type: "DELETE_PROFILE"; profileId: string }
  | { type: "SWITCH_PROFILE"; profileId: string }
  | { type: "SET_DEFAULT_PROFILE"; profileId: string }
  | { type: "IMPORT_PROFILE"; profile: Profile }
  | { type: "DUPLICATE_PROFILE"; profileId: string; newName: string };

export const initialAppState: AppState = {
  profiles: {
    default: {
      id: "default",
      name: "Default",
      description: "Default profile",
      servers: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      isDefault: true,
    },
  },
  activeProfileId: "default",
  servers: {},
  selectedServer: "none",
  selectedMultipleServers: [],
  isMultiSelectMode: false,
};
