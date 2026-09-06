/**
 * Origin Validation Middleware
 *
 * Blocks requests from non-localhost origins to prevent:
 * - DNS rebinding attacks
 * - CSRF attacks from malicious websites
 *
 * This is defense-in-depth alongside session token auth.
 */

import type { Context, Next } from "hono";
import { SERVER_PORT, parseAllowedHosts } from "../config.js";
import {
  hostnameMatchesAllowlist,
  isTunnelHost,
} from "../utils/localhost-check.js";
import { getActiveTunnelDomains } from "../services/tunnel-registry.js";
import { logger as appLogger } from "../utils/logger.js";

/**
 * Get the list of allowed origins.
 * Can be overridden via ALLOWED_ORIGINS environment variable.
 */
function getAllowedOrigins(): string[] {
  // Allow override via environment variable
  if (process.env.ALLOWED_ORIGINS) {
    const origins = process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());

    // Wildcard origins (e.g. https://*.up.railway.app) are only safe in
    // non-production environments that deliberately opt in via
    // MCPJAM_ALLOW_WILDCARD_ORIGINS (staging and PR previews, which need to
    // accept each other's ephemeral Railway hostnames). Reject them anywhere
    // else so a misconfiguration cannot weaken origin checks in production.
    if (process.env.MCPJAM_ALLOW_WILDCARD_ORIGINS !== "true") {
      const wildcards = origins.filter((o) => o.includes("*"));
      if (wildcards.length > 0) {
        appLogger.warn(
          `[Security] Wildcard ALLOWED_ORIGINS rejected without MCPJAM_ALLOW_WILDCARD_ORIGINS=true: ${wildcards.join(", ")}`,
        );
        return origins.filter((o) => !o.includes("*"));
      }
    }

    return origins;
  }

  // Default: localhost origins on common dev ports
  const clientPort = parseInt(process.env.CLIENT_PORT || "5173", 10);
  const ports = [SERVER_PORT, clientPort, 8080];
  const origins: string[] = [];

  for (const port of ports) {
    origins.push(`http://localhost:${port}`);
    origins.push(`http://127.0.0.1:${port}`);
  }

  return origins;
}

/**
 * The admin-configured `MCPJAM_ALLOWED_HOSTS` allowlist, read at call time so
 * tests (and any late env setup) see the current value — the same reason
 * `getAllowedOrigins` reads `ALLOWED_ORIGINS` lazily. Parsed identically to
 * `ALLOWED_HOSTS` in `config.ts` (the token gate's source).
 */
// Memoized on the raw env string: this runs on every /api/* request in the
// self-hosted LAN case (the browser Origin never matches getAllowedOrigins, so
// every request falls through to the allowlist check). Re-reading process.env
// each call keeps the lazy semantics tests rely on; the cache avoids re-parsing
// when the value hasn't changed.
let cachedAllowedHostsRaw: string | undefined;
let cachedAllowedHosts: string[] = [];
function getConfiguredAllowedHosts(): string[] {
  const raw = process.env.MCPJAM_ALLOWED_HOSTS;
  if (raw !== cachedAllowedHostsRaw) {
    cachedAllowedHostsRaw = raw;
    cachedAllowedHosts = parseAllowedHosts(raw);
  }
  return cachedAllowedHosts;
}

/**
 * The allowlist entries eligible for ORIGIN matching. Wildcard (`*`) entries
 * are stripped here unless `MCPJAM_ALLOW_WILDCARD_ORIGINS=true`, mirroring the
 * exact same production guard `getAllowedOrigins` applies to `ALLOWED_ORIGINS`.
 *
 * Why the origin gate is stricter than the token gate here: a platform wildcard
 * (e.g. `*.up.railway.app`) names every co-tenant on a shared platform domain.
 * Accepting all of them as request Origins in production is a CSRF surface the
 * wildcard-origin opt-in exists to gate. The TOKEN gate keeps honoring wildcard
 * `MCPJAM_ALLOWED_HOSTS` unchanged (it has its own established behavior/tests);
 * this narrowing applies only to Origin acceptance.
 *
 * Memoized on (opt-in flag, raw allowlist) so the "wildcard ignored" warning
 * fires ONCE per distinct configuration rather than on every Origin-bearing
 * request — this is on the hot path (see getConfiguredAllowedHosts), and a
 * per-request warn would flood the log sink.
 */
let cachedWildcardGateKey: string | undefined;
let cachedWildcardGatedHosts: string[] = [];
function getWildcardGatedAllowedHosts(): string[] {
  const optIn = process.env.MCPJAM_ALLOW_WILDCARD_ORIGINS === "true";
  const key = `${optIn ? "1" : "0"}|${process.env.MCPJAM_ALLOWED_HOSTS ?? ""}`;
  if (key === cachedWildcardGateKey) return cachedWildcardGatedHosts;
  cachedWildcardGateKey = key;

  const hosts = getConfiguredAllowedHosts();
  if (optIn) {
    cachedWildcardGatedHosts = hosts;
    return cachedWildcardGatedHosts;
  }
  const wildcards = hosts.filter((h) => h.includes("*"));
  if (wildcards.length > 0) {
    appLogger.warn(
      `[Security] Wildcard MCPJAM_ALLOWED_HOSTS entries ignored for Origin validation without MCPJAM_ALLOW_WILDCARD_ORIGINS=true: ${wildcards.join(", ")}`,
    );
    cachedWildcardGatedHosts = hosts.filter((h) => !h.includes("*"));
  } else {
    cachedWildcardGatedHosts = hosts;
  }
  return cachedWildcardGatedHosts;
}

/**
 * Is the request Origin's host on the `MCPJAM_ALLOWED_HOSTS` allowlist?
 *
 * This is what closes the gap where an operator sets `MCPJAM_ALLOWED_HOSTS`
 * to reach the inspector over the LAN (e.g. `192.168.1.50`): the token gate
 * then serves the token, but without this the origin gate still 403'd every
 * `connect` / tool / chat POST, because it only knew localhost + ALLOWED_ORIGINS.
 * One env var now opens BOTH gates. Localhost is intentionally NOT matched here
 * (its exact scheme+port origins stay governed by `getAllowedOrigins`); a bare
 * IP/host in the allowlist can never widen to localhost. DNS rebinding is still
 * blocked — a malicious domain's Origin host is not the allowlisted host.
 *
 * Matching is host-only (any scheme/port on the allowlisted host is accepted),
 * unlike the exact scheme+port localhost half. This is deliberate and mirrors
 * the token gate (`isAllowedHost` in localhost-check.ts also matches host-only),
 * so one `MCPJAM_ALLOWED_HOSTS` entry opens both gates consistently — the
 * allowlist is host-based and carries no port to match against. The tradeoff:
 * another service on the same allowlisted host (e.g. `https://192.168.1.50:9999`)
 * is also accepted as an Origin. That is the operator's trust decision when they
 * allowlist a host; an operator who wants a narrower origin surface can use the
 * exact-origin `ALLOWED_ORIGINS` instead.
 *
 * Two guards keep this from widening past that intent, matching the token gate's
 * discipline (`mayServeSessionToken`):
 * - A tunnel/relay host is vetoed BEFORE the allowlist, so even a
 *   `MCPJAM_ALLOWED_HOSTS` that names a tunnel domain can't make a tunnel Origin
 *   pass (this gate also fronts the local shell / browser routes).
 * - Wildcard entries are honored only under `MCPJAM_ALLOW_WILDCARD_ORIGINS`
 *   (see `getWildcardGatedAllowedHosts`).
 */
function originHostIsAllowlisted(origin: string): boolean {
  const allowedHosts = getWildcardGatedAllowedHosts();
  if (allowedHosts.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // A real browser `Origin` is a serialized origin: scheme://host[:port], with
  // no path, query, fragment, or userinfo. Reject anything else so a value like
  // `http://192.168.1.50:6274/evil` or `http://user@192.168.1.50:6274` can't
  // smuggle an allowlisted host past the check via `hostname` extraction.
  if (parsed.origin !== origin) return false;
  const hostname = parsed.hostname.toLowerCase();
  // Tunnel veto first — the same invariant the token gate enforces
  // (localhost-check.ts `mayServeSessionToken`): a tunnel host must never be
  // reachable through the allowlist, even if one is misconfigured into it.
  if (isTunnelHost(hostname, getActiveTunnelDomains())) return false;
  return hostnameMatchesAllowlist(hostname, allowedHosts);
}

/**
 * Check whether an origin matches the allowed list.
 *
 * Supports `*` anywhere in the host portion of the pattern, e.g.:
 *   - `https://*.up.railway.app`                  (subdomain wildcard)
 *   - `https://mcp-inspector-pr-*.up.railway.app` (mid-host wildcard for PR previews)
 *
 * Each `*` matches one or more host-safe characters (`[A-Za-z0-9-]+`);
 * it never crosses a dot, never matches the empty string, and never
 * matches scheme/port/path delimiters — so `*` cannot widen the
 * allowlist beyond the intended host shape.
 */
function matchesAllowedOrigin(
  origin: string,
  allowedOrigins: string[],
): boolean {
  for (const allowed of allowedOrigins) {
    if (allowed.includes("*")) {
      const schemeEnd = allowed.indexOf("://");
      if (schemeEnd === -1) continue;
      const scheme = allowed.slice(0, schemeEnd + 3); // "https://"
      const pattern = allowed.slice(schemeEnd + 3); // "mcp-inspector-pr-*.up.railway.app"

      if (!origin.startsWith(scheme)) continue;
      const originHost = origin.slice(scheme.length); // "mcp-inspector-pr-2246.up.railway.app"

      // Compile pattern: escape regex meta-chars, then expand `*` into
      // a host-segment-safe character class. We deliberately exclude `.`
      // and `:` so wildcards can't widen to cross-domain or cross-port.
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`^${escaped.replace(/\*/g, "[A-Za-z0-9-]+")}$`);
      if (regex.test(originHost)) {
        return true;
      }
    } else if (origin === allowed) {
      return true;
    }
  }
  return false;
}

/**
 * Is this `Origin` header value on the allowlist?
 *
 * Exported for handlers that must re-check the origin THEMSELVES rather than
 * rely on the middleware — currently the local computer terminal WebSocket,
 * which tightens the rule: an ABSENT Origin is allowed through by the
 * middleware below (curl, same-origin non-browser clients), but a browser
 * always sends one on a WS handshake, so the local PTY route treats "absent"
 * as a reject. Defense-in-depth only; the single-use nonce is the real gate.
 */
export function isAllowedRequestOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return (
    matchesAllowedOrigin(origin, getAllowedOrigins()) ||
    originHostIsAllowlisted(origin)
  );
}

/**
 * Origin validation middleware.
 * Blocks requests from non-localhost origins.
 */
export async function originValidationMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  // Allow CORS preflight requests through
  if (c.req.method === "OPTIONS") {
    return next();
  }

  // Static assets contain no sensitive data and are already excluded from
  // session auth.  Vite emits <script type="module" crossorigin> and
  // <link rel="stylesheet" crossorigin>, which cause the browser to attach
  // an Origin header.  Blocking them here breaks every preview deploy.
  const path = c.req.path;
  if (path.startsWith("/assets/")) {
    return next();
  }

  const origin = c.req.header("Origin");

  // No origin header = same-origin request or non-browser client (curl, etc.)
  // Most routes still require valid token; OAuth proxy routes rely on HTTPS-only + private IP blocking
  if (!origin) {
    return next();
  }

  const allowedOrigins = getAllowedOrigins();

  if (
    !matchesAllowedOrigin(origin, allowedOrigins) &&
    !originHostIsAllowlisted(origin)
  ) {
    appLogger.warn(`[Security] Blocked request from origin: ${origin}`);
    return c.json(
      {
        error: "Forbidden",
        message: "Request origin not allowed.",
      },
      403,
    );
  }

  return next();
}
