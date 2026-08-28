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

/**
 * Status label with the retry count appended when there is one to show:
 * `Failed (3)`.
 *
 * Shared so the card, the detail modal and the eval picker cannot drift
 * apart — one server reading `Failed (3)` in the grid and a bare `Failed`
 * in its own modal is the kind of disagreement that makes a user distrust
 * both numbers.
 *
 * The suffix is deliberately `failed`-only and deliberately conditional.
 * It used to render on every failure and always read `(0)`, because
 * nothing incremented the counter; the auto-connect retry loop now does,
 * so `Failed (3)` means we tried three times before giving up, and a
 * failure with no retries behind it — a protocol pin the server does not
 * offer, say — correctly shows no number at all.
 */
export const formatConnectionStatusLabel = (
  status: ConnectionStatus,
  retryCount: number | undefined
): string => {
  const { label } = getConnectionStatusMeta(status);
  if (status !== "failed") return label;
  if (!retryCount || retryCount <= 0) return label;
  return `${label} (${retryCount})`;
};

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
