import { createHash } from "node:crypto";
import { resolveWorkosClientId } from "../services/authkit-jwt.js";

/**
 * The local session namespace: which Inspector instance a browser session
 * belongs to.
 *
 * Cookies are scoped by host, not by port, so every Inspector on `localhost` —
 * two worktrees, a packaged `--port 7000`, a dev server on a random high port —
 * sees every other one's cookies. One shared session jar meant one instance's
 * login, refresh or logout rewrote the others'. Each instance now keeps its
 * own cookies, named by this namespace.
 *
 * The namespace is derived ONLY from server-resolved configuration:
 *
 *   - the browser port: the port the browser actually loads the app from
 *     (`MCPJAM_BROWSER_PORT`, set by the launcher; else the Vite client port in
 *     development; else the server port);
 *   - the backend identity: the Convex HTTP origin this instance talks to;
 *   - the WorkOS client id the instance signs in with.
 *
 * Never from `Origin`, `Referer`, `Host` or `X-Forwarded-*`: a request header
 * chooses nothing about whose session it reads. Two instances that differ in
 * any of the three never share a session, which is also what keeps a session
 * minted for one backend or WorkOS client from being replayed against another.
 */
export interface LocalSessionNamespace {
  /** 12 lowercase hex chars; the suffix of every scoped cookie name. */
  id: string;
  browserPort: number;
  backendIdentity: string;
  workosClientId: string;
}

function parsePort(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined;
  const port = Number(raw.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : undefined;
}

/** The browser-facing port, from configuration only. */
export function resolveBrowserPort(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const explicit = parsePort(env.MCPJAM_BROWSER_PORT);
  if (explicit) return explicit;
  const isDevClient =
    env.ENVIRONMENT === "dev" || env.NODE_ENV === "development";
  if (isDevClient) {
    return parsePort(env.CLIENT_PORT) ?? 5173;
  }
  return parsePort(env.SERVER_PORT) ?? parsePort(env.PORT) ?? 6274;
}

/** The backend this instance talks to, normalized to an origin. */
export function resolveBackendIdentity(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const name of ["CONVEX_HTTP_URL", "CONVEX_URL", "VITE_CONVEX_URL"]) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    try {
      return new URL(raw).origin;
    } catch {
      // try the next one
    }
  }
  return "none";
}

export function computeLocalSessionNamespace(parts: {
  browserPort: number;
  backendIdentity: string;
  workosClientId: string;
}): LocalSessionNamespace {
  const id = createHash("sha256")
    .update(
      [
        "mcpjam-local-session-ns-v1",
        String(parts.browserPort),
        parts.backendIdentity,
        parts.workosClientId,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 12);
  return { id, ...parts };
}

export function resolveLocalSessionNamespace(
  env: NodeJS.ProcessEnv = process.env,
): LocalSessionNamespace {
  return computeLocalSessionNamespace({
    browserPort: resolveBrowserPort(env),
    backendIdentity: resolveBackendIdentity(env),
    workosClientId: resolveWorkosClientId(env) ?? "none",
  });
}

/**
 * The process's namespace. Recomputed per call (one short hash) rather than
 * memoized, so it can never disagree with the configuration the rest of the
 * server reads; that configuration is fixed for the life of the process.
 */
export function getLocalSessionNamespace(): LocalSessionNamespace {
  return resolveLocalSessionNamespace(process.env);
}
