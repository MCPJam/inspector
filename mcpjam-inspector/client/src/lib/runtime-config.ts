export interface InspectorClientRuntimeConfig {
  convexUrl?: string;
  convexSiteUrl?: string;
  workosClientId?: string;
  workosApiHostname?: string;
}

declare global {
  interface Window {
    __MCP_RUNTIME_CONFIG__?: InspectorClientRuntimeConfig;
  }
}

function getRuntimeConfig(): InspectorClientRuntimeConfig | null {
  if (typeof window === "undefined") {
    return null;
  }

  const runtimeConfig = window.__MCP_RUNTIME_CONFIG__;
  if (!runtimeConfig || typeof runtimeConfig !== "object") {
    return null;
  }

  return runtimeConfig;
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function getRuntimeConvexUrl(): string | undefined {
  return getNonEmptyString(getRuntimeConfig()?.convexUrl);
}

export function getRuntimeConvexSiteUrl(): string | undefined {
  return getNonEmptyString(getRuntimeConfig()?.convexSiteUrl);
}

/**
 * WorkOS AuthKit client id, served by the document rather than inlined at build
 * time. See `getInspectorClientRuntimeConfig` in `server/env.ts` for why this
 * moved off `import.meta.env`.
 */
export function getRuntimeWorkosClientId(): string | undefined {
  return getNonEmptyString(getRuntimeConfig()?.workosClientId);
}

/**
 * Host AuthKit API calls are sent to. Must share a registrable domain with the
 * app origin, or the WorkOS session cookie is third-party and the refresh call
 * arrives with no credential.
 */
export function getRuntimeWorkosApiHostname(): string | undefined {
  return getNonEmptyString(getRuntimeConfig()?.workosApiHostname);
}
