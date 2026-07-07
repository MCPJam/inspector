import { DEFAULT_PLATFORM_API_BASE_URL } from "../platform/client.js";
import type { HostCompatCatalog } from "./catalog.js";
import { hostCompatCatalogEnvelopeSchema } from "./catalog-schema.js";

/**
 * Fetch the live host-compat catalog from the platform API. Deliberately NOT
 * a `PlatformApiClient` method: the endpoint is unauthenticated public
 * metadata, and consumers (CLI `compat`, inspector client) must be able to
 * call it with zero credentials. Never throws — every failure collapses to a
 * `{ok: false, reason}` so callers fall back to `bundledHostCompatCatalog()`.
 */

export type FetchHostCompatCatalogOptions = {
  /** API origin + version prefix. Defaults to the hosted production API. */
  baseUrl?: string;
  /** Abort the request after this long. Default 3000ms. */
  timeoutMs?: number;
  /** Injectable for tests / non-global-fetch runtimes. */
  fetchImpl?: typeof fetch;
};

export type FetchHostCompatCatalogResult =
  | {
      ok: true;
      catalog: HostCompatCatalog;
      version: number;
      contentHash: string;
      publishedAt: number;
      /** `live` | `bundled` from the serving proxy; defaults to `live`. */
      source: string;
    }
  | {
      ok: false;
      /**
       * `network` = request failed outright; `timeout` = aborted at
       * `timeoutMs`; `unavailable` = non-2xx (e.g. 503 catalog-not-seeded);
       * `invalid` = body wasn't a parseable catalog envelope.
       */
      reason: "network" | "timeout" | "invalid" | "unavailable";
    };

export async function fetchHostCompatCatalog(
  options?: FetchHostCompatCatalogOptions,
): Promise<FetchHostCompatCatalogResult> {
  const baseUrl = (options?.baseUrl ?? DEFAULT_PLATFORM_API_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const timeoutMs = options?.timeoutMs ?? 3000;
  const fetchImpl = options?.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/host-catalog`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) return { ok: false, reason: "unavailable" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid" };
  }

  const parsed = hostCompatCatalogEnvelopeSchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "invalid" };

  return {
    ok: true,
    catalog: parsed.data.catalog,
    version: parsed.data.version,
    contentHash: parsed.data.contentHash,
    publishedAt: parsed.data.publishedAt,
    source: parsed.data.source ?? "live",
  };
}
