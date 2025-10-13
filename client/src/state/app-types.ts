import { MCPServerConfig } from "@/sdk";
import { OauthTokens } from "@/shared/types.js";

export type ConnectionStatus =
  | "connected"
  | "connecting"
  | "failed"
  | "disconnected"
  | "oauth-flow";

export interface ServerWithName {
  name: string;
  config: MCPServerConfig;
  oauthTokens?: OauthTokens;
  lastConnectionTime: Date;
  connectionStatus: ConnectionStatus;
  retryCount: number;
  lastError?: string;
  enabled?: boolean;
}

export interface AppState {
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
  | { type: "SET_MULTI_MODE"; enabled: boolean };

export const initialAppState: AppState = {
  servers: {},
  selectedServer: "none",
  selectedMultipleServers: [],
  isMultiSelectMode: false,
};
