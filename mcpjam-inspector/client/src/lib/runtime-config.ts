export interface InspectorClientRuntimeConfig {
  convexUrl?: string;
  convexSiteUrl?: string;
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
