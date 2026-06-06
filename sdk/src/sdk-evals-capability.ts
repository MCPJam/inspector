/**
 * Lazy, per-baseUrl capability probe for SDK→backend eval ingestion
 * (Stage 5, Step 3).
 *
 * Probes `GET {baseUrl}/sdk/v1/info` on first call per baseUrl; caches the
 * resolved Promise so subsequent reporters in the same process share the
 * result. Fail-safe: any error (network, 404, non-200, parse, timeout)
 * resolves to "no capability" so the reporter simply omits `hostConfig`
 * rather than failing the report.
 *
 * Backend contract (Stage 5, Step 2):
 *   GET /sdk/v1/info  →  200 { "capabilities": { "evalsHostConfig": 1 } }
 *
 * Older backends return 404 or omit the field — both are treated as
 * "capability absent → don't send hostConfig". A future flat shape
 * (`{ evalsHostConfig: 1 }` at the body root) is also tolerated.
 */

const INFO_PATH = "/sdk/v1/info";
const PROBE_TIMEOUT_MS = 2000;

/** Capability advertisement returned by `/sdk/v1/info`. */
export interface SdkEvalsCapabilities {
  /**
   * `>= 1` means the backend accepts `{ hostConfig, hostConfigHash }` at
   * the top level of `/sdk/v1/evals/*` request bodies. `0` means absent.
   */
  readonly evalsHostConfig: number;
}

// Module-level cache keyed by normalized baseUrl. We cache the Promise (not
// the resolved value) so concurrent first-callers share a single in-flight
// fetch. Pinned for the process lifetime — a long-lived runner shouldn't
// pay for repeated probes, and backend capability flips are deploy events
// (process restart), not runtime ones.
const cache = new Map<string, Promise<SdkEvalsCapabilities>>();

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function readEvalsHostConfigField(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const body = value as {
    capabilities?: { evalsHostConfig?: unknown };
    evalsHostConfig?: unknown;
  };
  const nested = body.capabilities?.evalsHostConfig;
  if (typeof nested === "number" && Number.isFinite(nested)) {
    return nested;
  }
  const flat = body.evalsHostConfig;
  if (typeof flat === "number" && Number.isFinite(flat)) {
    return flat;
  }
  return 0;
}

async function probe(
  baseUrl: string,
  fetchImpl: typeof fetch
): Promise<SdkEvalsCapabilities> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}${INFO_PATH}`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { evalsHostConfig: 0 };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { evalsHostConfig: 0 };
    }
    return { evalsHostConfig: readEvalsHostConfigField(body) };
  } catch {
    // Network error, AbortError (timeout), DNS failure, etc.
    return { evalsHostConfig: 0 };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Resolve (and cache) the SDK eval ingestion capabilities for `baseUrl`.
 *
 * Idempotent and concurrency-safe: repeated calls with the same baseUrl
 * share one in-flight `fetch`. Errors resolve to `{ evalsHostConfig: 0 }`.
 *
 * @param baseUrl backend base URL (e.g. `https://sdk.mcpjam.com`); trailing
 *   `/` tolerated.
 * @param fetchImpl optional fetch override (used by tests; defaults to the
 *   global `fetch`).
 */
export function resolveSdkEvalsCapabilities(
  baseUrl: string,
  fetchImpl?: typeof fetch
): Promise<SdkEvalsCapabilities> {
  const normalized = normalizeBaseUrl(baseUrl);
  const cached = cache.get(normalized);
  if (cached) return cached;
  const fetcher = fetchImpl ?? globalThis.fetch;
  const promise = probe(normalized, fetcher);
  cache.set(normalized, promise);
  return promise;
}

/**
 * Test-only seam: clear the module-level capability cache. NOT part of the
 * public API — exposed so vitest can drive the probe deterministically
 * across cases without spawning new module realms.
 */
export function __resetSdkEvalsCapabilitiesCache(): void {
  cache.clear();
}
