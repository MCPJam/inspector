import type { ComponentType } from "react";
import { Check, KeyRound, Loader2, Wifi, X } from "lucide-react";
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
  // Amber, not red: the server is fine, it just has nobody signed in. The
  // vocabulary matches the `needsReconnect` affordance on the card, which
  // already uses amber for "this needs a decision from you".
  "needs-auth": {
    label: "Sign in",
    indicatorColor: "#f59e0b",
    Icon: KeyRound,
    iconClassName: "h-3 w-3 text-amber-500",
  },
  failed: {
    label: "Failed",
    indicatorColor: "#ef4444",
    Icon: X,
    iconClassName: "h-3 w-3 text-red-500",
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
