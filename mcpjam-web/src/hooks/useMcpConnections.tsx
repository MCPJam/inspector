import { useContext } from "react";
import {
  McpConnectionsContext,
  type McpConnectionsContextValue,
} from "./mcpConnectionsContext";

export type {
  MCPServerConnection,
  ConnectServerInput,
  McpConnectionsContextValue,
  MCPOAuthConfig,
  MCPConnectionError,
  MCPTransportType,
} from "./mcpConnectionsContext";

export function useMcpConnections(): McpConnectionsContextValue {
  const context = useContext(McpConnectionsContext);
  if (!context) {
    throw new Error("useMcpConnections must be used within a McpConnectionsProvider");
  }
  return context;
}
