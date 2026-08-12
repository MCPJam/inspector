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

export function resolveWorkosClientOptions(
  env: WorkosAuthkitEnv,
  location?: WorkosAuthkitLocation
): WorkosClientOptions {
  if (env.VITE_WORKOS_API_HOSTNAME) {
    return { apiHostname: env.VITE_WORKOS_API_HOSTNAME };
  }

  const disableProxy = env.VITE_WORKOS_DISABLE_LOCAL_PROXY === "true";
  if (
    disableProxy ||
    !location ||
    !LOCAL_WORKOS_HOSTNAMES.has(location.hostname)
  ) {
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
