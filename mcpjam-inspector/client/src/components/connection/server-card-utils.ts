import type { ComponentType } from "react";
import { Check, Loader2, Wifi, X } from "lucide-react";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { ConnectionStatus } from "@/state/app-types";

interface ConnectionStatusMeta {
  label: string;
  /**
   * The status dot's colour, as a ROLE TOKEN class rather than a fixed value.
   *
   * It was a hex string painted through `style={{ backgroundColor }}`, which
   * follows neither theme: the same `#10b981` sat on the light and the dark
   * ground. Every surface that shows this dot — the two connection cards, the
   * header's server strip, the server picker — now reads this one field, so
   * `connected` is one green and changing it is one edit.
   */
  indicatorClassName: string;
  Icon: ComponentType<{ className?: string }>;
  /**
   * Role tokens here too. This field kept `text-green-500` and friends after
   * the dot beside it moved to `bg-success`, so one status was painted from
   * the theme and from a fixed shade at the same time, a field apart.
   * `AGENTS.md`: "Never hardcode a color value."
   */
  iconClassName: string;
}

const connectionStatusMeta: Record<ConnectionStatus, ConnectionStatusMeta> = {
  connected: {
    label: "Connected",
    indicatorClassName: "bg-success",
    Icon: Check,
    iconClassName: "h-3 w-3 text-success",
  },
  connecting: {
    label: "Finishing setup...",
    indicatorClassName: "bg-info",
    Icon: Loader2,
    iconClassName: "h-3 w-3 text-info animate-spin",
  },
  "oauth-flow": {
    label: "Authorizing in browser...",
    indicatorClassName: "bg-pending",
    Icon: Loader2,
    iconClassName: "h-3 w-3 text-pending animate-spin",
  },
  failed: {
    label: "Failed",
    indicatorClassName: "bg-destructive",
    Icon: X,
    iconClassName: "h-3 w-3 text-destructive",
  },
  disconnected: {
    label: "Disconnected",
    indicatorClassName: "bg-muted-foreground",
    Icon: Wifi,
    iconClassName: "h-3 w-3 text-muted-foreground",
  },
};

export const getConnectionStatusMeta = (status: ConnectionStatus) =>
  connectionStatusMeta[status] || connectionStatusMeta.disconnected;

/**
 * Is this string one of the statuses we actually model?
 *
 * Runtime values reach the UI as plain strings widened with `as
 * ConnectionStatus`, so a value outside the union does arrive. It matters
 * because the two answers are different claims: `getConnectionStatusMeta`
 * falls back to `disconnected`, which SAYS the server is not connected, and
 * that is a statement we have no basis for when we cannot read the state at
 * all.
 */
export const isConnectionStatus = (
  status: string,
): status is ConnectionStatus =>
  Object.prototype.hasOwnProperty.call(connectionStatusMeta, status);

/**
 * The dot for a state we cannot read: it holds a row's alignment without
 * asserting anything. Grey would read as `disconnected`; transparent reads as
 * nothing, which is the truth.
 *
 * Shared so the picker's popover and the header's strip make the same
 * non-claim — they had drifted into making opposite ones.
 */
export const UNKNOWN_CONNECTION_STATUS = {
  label: "Connection state unavailable",
  indicatorClassName: "bg-transparent",
} as const;

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
