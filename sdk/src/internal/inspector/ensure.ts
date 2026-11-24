import { operationalError } from "./errors.js";
import { resolveInspectorBrowserBaseUrlForHealth } from "./frontend.js";
import { getInspectorHealth, isInspectorHealthy } from "./health.js";
import { openUrl, startInspector } from "./launch.js";
import {
  clearInspectorSessionTokenCache,
  fetchInspectorSessionToken,
  isAuthFailure,
} from "./session-token.js";
import {
  buildInspectorAccessUrl,
  buildInspectorUrl,
  normalizeExplicitInspectorFrontendUrl,
  normalizeInspectorBaseUrl,
} from "./urls.js";

const DEFAULT_START_TIMEOUT_MS = 30_000;
const STOP_FETCH_TIMEOUT_MS = 3_000;

export interface InspectorStartOptions {
  baseUrl?: string;
  /**
   * The local `@mcpjam/inspector` start script, resolved only when a start is
   * needed. Without one (or when it is missing) the Inspector starts through
   * `npx -y @mcpjam/inspector@latest`.
   */
  resolveStartScriptPath?: () => string | undefined;
}

export interface EnsureInspectorOptions extends InspectorStartOptions {
  frontendUrl?: string;
  openBrowser?: boolean;
  skipDiscovery?: boolean;
  startIfNeeded?: boolean;
  tab?: string;
  timeoutMs?: number;
}

export interface EnsureInspectorResult {
  baseUrl: string;
  frontendUrl?: string;
  hasActiveClient: boolean;
  url: string;
  started: boolean;
}

export async function ensureInspector(
  options: EnsureInspectorOptions = {},
): Promise<EnsureInspectorResult> {
  const baseUrl = normalizeInspectorBaseUrl(options.baseUrl);
  const explicitFrontendUrl =
    options.frontendUrl !== undefined
      ? normalizeExplicitInspectorFrontendUrl(options.frontendUrl)
      : undefined;

  const health = await getInspectorHealth(baseUrl);
  if (health.healthy) {
    const browserBaseUrl =
      explicitFrontendUrl ??
      (await resolveInspectorBrowserBaseUrlForHealth(baseUrl, health.frontendUrl, {
        hasActiveClient: health.hasActiveClient,
        openBrowser: options.openBrowser === true,
        skipDiscovery: options.skipDiscovery,
      }));
    const url = buildInspectorUrl(browserBaseUrl, options.tab);
    if (options.openBrowser && !health.hasActiveClient) {
      openUrl(
        buildInspectorAccessUrl(url, await fetchInspectorSessionToken(baseUrl))
      );
    }
    return {
      baseUrl,
      ...(browserBaseUrl !== baseUrl ? { frontendUrl: browserBaseUrl } : {}),
      hasActiveClient: health.hasActiveClient,
      url,
      started: false,
    };
  }

  if (!options.startIfNeeded) {
    throw operationalError(
      "Inspector is not running. Run `mcpjam inspector open` first or pass an Inspector-backed option that starts it.",
    );
  }

  await startInspector(
    baseUrl,
    options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    options.resolveStartScriptPath,
  );
  clearInspectorSessionTokenCache(baseUrl);

  const startedHealth = await getInspectorHealth(baseUrl);
  const browserBaseUrl =
    explicitFrontendUrl ??
    (await resolveInspectorBrowserBaseUrlForHealth(
      baseUrl,
      startedHealth.frontendUrl,
      {
        hasActiveClient: startedHealth.hasActiveClient,
        openBrowser: options.openBrowser === true,
        skipDiscovery: options.skipDiscovery,
      },
    ));
  const url = buildInspectorUrl(browserBaseUrl, options.tab);

  if (options.openBrowser) {
    openUrl(
      buildInspectorAccessUrl(url, await fetchInspectorSessionToken(baseUrl))
    );
  }

  return {
    baseUrl,
    ...(browserBaseUrl !== baseUrl ? { frontendUrl: browserBaseUrl } : {}),
    hasActiveClient: startedHealth.hasActiveClient,
    url,
    started: true,
  };
}

export interface EnsureInspectorBackendOptions extends InspectorStartOptions {
  startIfNeeded?: boolean;
  timeoutMs?: number;
}

export interface EnsureInspectorBackendResult {
  baseUrl: string;
  hasActiveClient: boolean;
  started: boolean;
}

/**
 * Ensure the local Inspector BACKEND is reachable (starting it if asked),
 * without resolving a browser frontend URL. Headless callers (e.g. `apps
 * render`, which runs the render server-side) need only a live backend — and
 * the full {@link ensureInspector} additionally probes/validates the frontend
 * and can throw a frontend-mismatch error when no browser client is present,
 * which would wrongly block a render that never touches the browser UI.
 */
export async function ensureInspectorBackend(
  options: EnsureInspectorBackendOptions = {},
): Promise<EnsureInspectorBackendResult> {
  const baseUrl = normalizeInspectorBaseUrl(options.baseUrl);

  const health = await getInspectorHealth(baseUrl);
  if (health.healthy) {
    return { baseUrl, hasActiveClient: health.hasActiveClient, started: false };
  }

  if (!options.startIfNeeded) {
    throw operationalError(
      "Inspector is not running. Run `mcpjam inspector open` first or pass an Inspector-backed option that starts it.",
    );
  }

  await startInspector(
    baseUrl,
    options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    options.resolveStartScriptPath,
  );
  clearInspectorSessionTokenCache(baseUrl);

  const startedHealth = await getInspectorHealth(baseUrl);
  return {
    baseUrl,
    hasActiveClient: startedHealth.hasActiveClient,
    started: true,
  };
}

export async function stopInspector(
  baseUrl: string,
): Promise<{ stopped: boolean; baseUrl: string }> {
  const normalized = normalizeInspectorBaseUrl(baseUrl);

  if (!(await isInspectorHealthy(normalized))) {
    return { stopped: false, baseUrl: normalized };
  }

  const fetchShutdown = async (): Promise<Response> => {
    const token = await fetchInspectorSessionToken(normalized);
    return await fetch(`${normalized}/api/shutdown`, {
      method: "POST",
      headers: {
        "X-MCP-Session-Auth": `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(STOP_FETCH_TIMEOUT_MS),
    });
  };

  try {
    let response = await fetchShutdown();
    if (isAuthFailure(response)) {
      clearInspectorSessionTokenCache(normalized);
      response = await fetchShutdown();
    }
    if (response.ok) {
      clearInspectorSessionTokenCache(normalized);
    }
    return { stopped: response.ok, baseUrl: normalized };
  } catch {
    return { stopped: false, baseUrl: normalized };
  }
}
