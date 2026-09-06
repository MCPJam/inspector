import type { ComponentType } from "react";
import { Check, Loader2, Wifi, X } from "lucide-react";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { ConnectionStatus } from "@/state/app-types";

interface ConnectionStatusMeta {
  label: string;
  /**
   * Literal hex, read by the three server cards that predate the role tokens.
   * Prefer `indicatorClassName` — a hex does not track the theme, and
   * AGENTS.md rules it out for new code. Converting those cards is its own
   * change.
   */
  indicatorColor: string;
  /** Background utility for a status dot, wired to a design-system role token. */
  indicatorClassName: string;
  Icon: ComponentType<{ className?: string }>;
  iconClassName: string;
}

const connectionStatusMeta: Record<ConnectionStatus, ConnectionStatusMeta> = {
  connected: {
    label: "Connected",
    indicatorColor: "#10b981",
    indicatorClassName: "bg-success",
    Icon: Check,
    iconClassName: "h-3 w-3 text-green-500",
  },
  connecting: {
    label: "Finishing setup...",
    indicatorColor: "#3b82f6",
    indicatorClassName: "bg-info",
    Icon: Loader2,
    iconClassName: "h-3 w-3 text-blue-500 animate-spin",
  },
  "oauth-flow": {
    label: "Authorizing in browser...",
    indicatorColor: "#a855f7",
    // No purple role token. `pending` is the waiting-on-something role, which
    // is what an in-browser authorization is, and keeps it distinct from
    // `connecting`'s `info`.
    indicatorClassName: "bg-pending",
    Icon: Loader2,
    iconClassName: "h-3 w-3 text-purple-500 animate-spin",
  },
  failed: {
    label: "Failed",
    indicatorColor: "#ef4444",
    indicatorClassName: "bg-destructive",
    Icon: X,
    iconClassName: "h-3 w-3 text-red-500",
  },
  disconnected: {
    label: "Disconnected",
    indicatorColor: "#9ca3af",
    indicatorClassName: "bg-muted-foreground",
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
