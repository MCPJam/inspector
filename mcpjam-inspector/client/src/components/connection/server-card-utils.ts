import type { ComponentType } from "react";
import { AlertTriangle, Check, Loader2, Wifi } from "lucide-react";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { ConnectionStatus } from "@/state/app-types";

interface ConnectionStatusMeta {
  label: string;
  indicatorColor: string;
  Icon: ComponentType<{ className?: string }>;
  iconClassName: string;
}

const connectionStatusMeta: Record<ConnectionStatus, ConnectionStatusMeta> = {
  connected: {
    label: "Connected",
    indicatorColor: "#10b981",
    Icon: Check,
    iconClassName: "h-3 w-3 text-green-500",
  },
  connecting: {
    label: "Finishing setup...",
    indicatorColor: "#3b82f6",
    Icon: Loader2,
    iconClassName: "h-3 w-3 text-blue-500 animate-spin",
  },
  "oauth-flow": {
    label: "Authorizing in browser...",
    indicatorColor: "#a855f7",
    Icon: Loader2,
    iconClassName: "h-3 w-3 text-purple-500 animate-spin",
  },
  failed: {
    // Soft-fail language on purpose: an auto-connect miss is almost always
    // recoverable (stale token, sleeping server, one-off network blip) and
    // the user has a clear next action (reconnect / re-auth). Red "Failed"
    // read as a dead end; amber "Could not connect" plus the tooltip's
    // cause + fix (see ServerConnectionCard) matches the severity users
    // actually attach to this state (PUR-22).
    label: "Could not connect",
    indicatorColor: "#f59e0b",
    Icon: AlertTriangle,
    iconClassName: "h-3 w-3 text-amber-500",
  },
  disconnected: {
    label: "Disconnected",
    indicatorColor: "#9ca3af",
    Icon: Wifi,
    iconClassName: "h-3 w-3 text-gray-500",
  },
};

export const getConnectionStatusMeta = (status: ConnectionStatus) =>
  connectionStatusMeta[status] || connectionStatusMeta.disconnected;

export const getServerCommandDisplay = (config: MCPServerConfig): string => {
  if (config.url) {
    return config.url.toString();
  }

  const command = config.command ?? "";
  const args = config.args ?? [];
  return [command, ...args].filter(Boolean).join(" ").trim();
};

/** HTTP/SSE URL or joined stdio command string, for agent briefs / export metadata. */
export const getServerUrl = (config: MCPServerConfig): string | undefined => {
  if (config.url) {
    return config.url.toString();
  }
  const command = config.command ?? "";
  const args = config.args ?? [];
  const joined = [command, ...args].filter(Boolean).join(" ").trim();
  return joined.length > 0 ? joined : undefined;
};

export const getServerTransportLabel = (config: MCPServerConfig): string => {
  return config.url ? "HTTP/SSE" : "STDIO";
};
