type WorkosAuthkitEnv = {
  DEV?: boolean;
  VITE_WORKOS_API_HOSTNAME?: string;
  VITE_WORKOS_DISABLE_LOCAL_PROXY?: string;
};

type WorkosAuthkitLocation = Pick<Location, "hostname" | "port" | "protocol">;

export type WorkosClientOptions = {
  apiHostname?: string;
  https?: boolean;
  port?: number;
};

const WORKOS_REFRESH_TOKEN_KEY = "workos:refresh-token";
const LOCAL_WORKOS_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/**
 * AuthKit runs in cookie mode on every surface, so `devMode` is always false.
 *
 * This is passed explicitly rather than omitted: `@workos-inc/authkit-js`
 * defaults `devMode` to `location.hostname === "localhost"`, which would put
 * local dev on a different session-storage path (refresh token in
 * `localStorage`) than every deployed environment (refresh token in memory,
 * restored from the AuthKit session cookie). Local dev reaches cookie mode
 * through the first-party AuthKit proxy this server mounts at
 * `/user_management` — see `resolveWorkosClientOptions` below and
 * `server/routes/workos-authkit.ts`.
 *
 * There was a `VITE_WORKOS_DEV_MODE` escape hatch here. It was set in no
 * environment, was absent from the Dockerfile `ARG` allowlist so no deployed
 * build could set it, and existed only to opt out of the mode the proxy was
 * added to make universal.
 */
export const WORKOS_DEV_MODE = false;

/**
 * Where AuthKit should send its requests.
 *
 * Precedence: an explicit `VITE_WORKOS_API_HOSTNAME` wins (prod pins
 * `auth.mcpjam.com`), then the proxy opt-out, then this origin.
 *
 * The same-origin default covers hosted deployments as well as localhost,
 * because the reason is the same in both: AuthKit's `initialize()` short-
 * circuits — no network call whatsoever — unless the page's OWN cookies carry
 * `workos-has-session`, and only a first-party response can set it. A client
 * calling `api.workos.com` direct gets that cookie written on WorkOS's domain,
 * where the page cannot see it, so every reload reads as signed out and the
 * app drops to a guest. That was staging's bug.
 *
 * Hosted has to be told, not sniffed: the deciding factor is whether this
 * origin's server mounts the `/user_management` proxy, which a hostname cannot
 * reveal. Deployments that keep a same-site WorkOS domain simply set the
 * explicit hostname above and never reach this branch.
 */
export function resolveWorkosClientOptions(
  env: WorkosAuthkitEnv,
  location?: WorkosAuthkitLocation,
  hostedMode = false
): WorkosClientOptions {
  if (env.VITE_WORKOS_API_HOSTNAME) {
    return { apiHostname: env.VITE_WORKOS_API_HOSTNAME };
  }

  const disableProxy = env.VITE_WORKOS_DISABLE_LOCAL_PROXY === "true";
  if (disableProxy || !location) {
    return {};
  }

  // Both branches mean the same thing: this origin's server mounts the
  // `/user_management` proxy, so AuthKit can be pointed at it.
  const servesAuthkitProxy =
    hostedMode || LOCAL_WORKOS_HOSTNAMES.has(location.hostname);
  if (!servesAuthkitProxy) {
    return {};
  }

  const parsedPort = location.port ? Number(location.port) : undefined;
  return {
    apiHostname: location.hostname,
    https: location.protocol === "https:",
    ...(parsedPort ? { port: parsedPort } : {}),
  };
}

export function clearLegacyWorkosRefreshTokenStorage(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(WORKOS_REFRESH_TOKEN_KEY);
  } catch {
    // best effort only
  }
}
