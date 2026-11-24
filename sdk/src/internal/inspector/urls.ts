import { operationalError } from "./errors.js";

const FALLBACK_INSPECTOR_BASE_URL = "http://127.0.0.1:6274";

export function normalizeInspectorBaseUrl(baseUrl: string | undefined): string {
  const value =
    baseUrl?.trim() ||
    process.env.MCPJAM_INSPECTOR_URL?.trim() ||
    FALLBACK_INSPECTOR_BASE_URL;

  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.search = "";
    return parsed.href.replace(/\/$/, "");
  } catch (error) {
    throw operationalError(
      `Invalid Inspector URL "${value}".`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function buildInspectorUrl(baseUrl: string, tab?: string): string {
  if (!tab || !tab.trim()) {
    return baseUrl;
  }

  return `${baseUrl}/#${tab.trim()}`;
}

export function normalizeInspectorFrontendUrl(
  frontendUrl: unknown,
): string | undefined {
  if (typeof frontendUrl !== "string" || !frontendUrl.trim()) {
    return undefined;
  }

  try {
    const parsed = new URL(frontendUrl.trim());
    parsed.hash = "";
    parsed.search = "";
    return parsed.href.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function normalizeExplicitInspectorFrontendUrl(frontendUrl: string): string {
  const normalized = normalizeInspectorFrontendUrl(frontendUrl);
  if (!normalized) {
    throw operationalError(`Invalid Inspector frontend URL "${frontendUrl}".`);
  }
  return normalized;
}

export function canonicalizeInspectorFrontendUrl(
  baseUrl: string,
  frontendUrl: string | undefined,
): string | undefined {
  if (!frontendUrl) {
    return undefined;
  }

  try {
    const base = new URL(baseUrl);
    const frontend = new URL(frontendUrl);
    if (
      isLoopbackHostname(base.hostname) &&
      isLoopbackHostname(frontend.hostname) &&
      base.protocol === frontend.protocol &&
      getEffectiveUrlPort(base) === getEffectiveUrlPort(frontend)
    ) {
      return baseUrl;
    }
  } catch {
    return frontendUrl;
  }

  return frontendUrl;
}

function getEffectiveUrlPort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : "80";
}

export function buildInspectorBrowserUrl(
  baseUrl: string,
  frontendUrl?: string,
  tab?: string,
): string {
  return buildInspectorUrl(
    canonicalizeInspectorFrontendUrl(
      baseUrl,
      normalizeInspectorFrontendUrl(frontendUrl),
    ) ?? baseUrl,
    tab,
  );
}

export function getUrlHostname(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function getUrlProtocol(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}

export function getUrlPort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function formatUrlHostname(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
}

/** Browser-only credential; keep command results and diagnostics on clean URLs. */
export function buildInspectorAccessUrl(url: string, token: string): string {
  const target = new URL(url);
  const tab = target.hash.slice(1);
  target.hash = new URLSearchParams({
    token,
    ...(tab ? { tab } : {}),
  }).toString();
  return target.href;
}
