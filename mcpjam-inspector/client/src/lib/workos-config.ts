import { createClient } from "@workos-inc/authkit-js";

type WorkosClientOptions = NonNullable<Parameters<typeof createClient>[1]>;

export function getWorkosClientId(): string {
  return import.meta.env.VITE_WORKOS_CLIENT_ID as string;
}

export function getWorkosDevMode(): boolean {
  const explicit = import.meta.env.VITE_WORKOS_DEV_MODE as string | undefined;
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  if (import.meta.env.DEV) return true;

  return location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

export function getWorkosRedirectUri(): string {
  const envRedirect =
    (import.meta.env.VITE_WORKOS_REDIRECT_URI as string) || undefined;
  if (typeof window === "undefined") return envRedirect ?? "/callback";

  const isBrowserHttp =
    window.location.protocol === "http:" ||
    window.location.protocol === "https:";
  if (isBrowserHttp) return `${window.location.origin}/callback`;
  if (envRedirect) return envRedirect;
  if ((window as any)?.isElectron) return "mcpjam://oauth/callback";
  return `${window.location.origin}/callback`;
}

export function getWorkosClientOptions(): WorkosClientOptions {
  const envApiHostname = import.meta.env.VITE_WORKOS_API_HOSTNAME as
    | string
    | undefined;
  if (envApiHostname) {
    return { apiHostname: envApiHostname };
  }

  if (typeof window === "undefined") return {};
  const disableProxy =
    (import.meta.env.VITE_WORKOS_DISABLE_LOCAL_PROXY as string | undefined) ===
    "true";
  if (!import.meta.env.DEV || disableProxy) return {};

  const { protocol, hostname, port } = window.location;
  const parsedPort = port ? Number(port) : undefined;
  return {
    apiHostname: hostname,
    https: protocol === "https:",
    ...(parsedPort ? { port: parsedPort } : {}),
  };
}
