import { createClient } from "@workos-inc/authkit-js";

type WorkosClientOptions = NonNullable<Parameters<typeof createClient>[1]>;
const ELECTRON_HOSTED_AUTH_STATE_FLAG = "electronHostedAuth";

function createElectronHostedAuthNonce() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseWorkosState(
  rawState: string | null,
): Record<string, unknown> | null {
  if (!rawState) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawState);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function createElectronHostedAuthState(state?: unknown) {
  return {
    [ELECTRON_HOSTED_AUTH_STATE_FLAG]: true,
    nonce: createElectronHostedAuthNonce(),
    ...(state !== undefined ? { originalState: state } : {}),
  };
}

export function buildElectronHostedAuthCallbackUrl(
  url: URL | Location = window.location,
): string | null {
  if (typeof window === "undefined" || (window as any)?.isElectron) {
    return null;
  }

  const sourceUrl = url instanceof URL ? url : new URL(url.href);
  if (sourceUrl.pathname !== "/callback") {
    return null;
  }

  const parsedState = parseWorkosState(sourceUrl.searchParams.get("state"));
  if (!parsedState?.[ELECTRON_HOSTED_AUTH_STATE_FLAG]) {
    return null;
  }

  const callbackUrl = new URL("mcpjam://oauth/callback");
  for (const [key, value] of sourceUrl.searchParams.entries()) {
    callbackUrl.searchParams.append(key, value);
  }

  return callbackUrl.toString();
}

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
  if ((window as any)?.isElectron) {
    return envRedirect ?? "mcpjam://oauth/callback";
  }
  if (envRedirect) return envRedirect;
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
