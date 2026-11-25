/**
 * DNS rebinding guard for the local server: a request must name this server
 * in its `Host` header.
 *
 * A page on `attacker.example` can point its own hostname at 127.0.0.1. The
 * browser then sends that page's requests here as same-origin, so no `Origin`
 * check sees them, but with `Host: attacker.example:6274`. Local mode only:
 * a hosted deployment is reached through its platform's routing.
 *
 * Allowed: a loopback name, on any port (a browser names the host it
 * connected to, and a rebinding page's name is its own, so a remapped Docker
 * port or a local proxy is not a rebinding); a host in `MCPJAM_ALLOWED_HOSTS`
 * (any port, as the token and origin gates read it); the host of an origin
 * this instance is configured to be reached at; and a live tunnel's host. A
 * request with no `Host` header is not a browser's, so there is nothing to
 * rebind.
 */
import type { Context, Next } from "hono";
import { isLocalEventsHookPost } from "@/shared/local-events-hooks";
import { SERVER_PORT, parseAllowedHosts } from "../config.js";
import { hostnameMatchesAllowlist } from "../utils/localhost-check.js";
import { isActiveTunnelDomain } from "../services/tunnel-registry.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A hostname or bracketed IPv6 literal, then an optional port; nothing else. */
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/;

/** Where the launcher, an operator or the Electron shell says this is reached. */
const CONFIGURED_ORIGINS = [
  "BASE_URL",
  "ALLOWED_ORIGINS",
  "WEB_ALLOWED_ORIGINS",
  "MCPJAM_PUBLIC_ORIGIN",
  "MCPJAM_INSPECTOR_FRONTEND_URL",
  "CLI_AUTH_PUBLIC_ORIGIN",
  "SLACK_LINK_PUBLIC_ORIGIN",
  "DISCORD_LINK_PUBLIC_ORIGIN",
];

function configuredHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const name of CONFIGURED_ORIGINS) {
    for (const entry of (process.env[name] ?? "").split(",")) {
      const origin = entry.trim();
      if (URL.canParse(origin)) hosts.add(new URL(origin).host);
    }
  }
  return hosts;
}

/** Read per request, as the origin gate reads its environment. */
function isAllowedLocalHost(hostHeader: string): boolean {
  const host = hostHeader.trim().toLowerCase();
  const match = HOST_HEADER.exec(host);
  if (!match) return false;
  const [, hostname] = match;
  return (
    LOOPBACK_HOSTNAMES.has(hostname) ||
    hostnameMatchesAllowlist(
      hostname,
      parseAllowedHosts(process.env.MCPJAM_ALLOWED_HOSTS),
    ) ||
    isActiveTunnelDomain(host) ||
    configuredHosts().has(host)
  );
}

export async function localHostAllowlistMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  if (isLocalEventsHookPost(c.req.method, c.req.path)) return next();
  const host = c.req.header("Host");
  if (host === undefined || isAllowedLocalHost(host)) return next();
  return c.json(
    {
      error: "Forbidden",
      code: "HOST_NOT_ALLOWED",
      message: `MCPJam Inspector can't be opened at ${host}. Open it at http://localhost:${SERVER_PORT}, or add this host to MCPJAM_ALLOWED_HOSTS.`,
    },
    403,
  );
}
