type WorkosAuthkitEnv = {
  DEV?: boolean;
  VITE_WORKOS_API_HOSTNAME?: string;
  VITE_WORKOS_DEV_MODE?: string;
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

export function resolveWorkosDevMode(env: WorkosAuthkitEnv): boolean {
  const explicit = env.VITE_WORKOS_DEV_MODE;
  if (explicit === "true") return true;
  if (explicit === "false") return false;

  // Keep local/dev on the same AuthKit cookie-mode path as hosted by default.
  // `devMode=true` stores the WorkOS refresh token in browser localStorage.
  return false;
}

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
