import { DEFAULT_PLATFORM_API_BASE_URL } from "../platform/client.js";
import {
  hydrateHostCompatCatalog,
  type HostCompatCatalog,
} from "./catalog.js";
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
  options?: FetchHostCompatCatalogOptions
): Promise<FetchHostCompatCatalogResult> {
  const baseUrl = (options?.baseUrl ?? DEFAULT_PLATFORM_API_BASE_URL).replace(
    /\/+$/,
    ""
  );
  const timeoutMs = options?.timeoutMs ?? 3000;
  // Read the global via `globalThis` (not a bare `fetch`) so a runtime without
  // a fetch binding yields `undefined` instead of a ReferenceError thrown
  // outside the try — the never-throws contract must hold everywhere. Bind the
  // global to `globalThis` too: a detached `fetch` throws "Illegal invocation"
  // in browsers/workers when called without its receiver.
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "network" };
  }

  // The abort deadline must cover the WHOLE exchange: `fetch` resolves on
  // headers, so clearing the timer before `response.json()` would leave a
  // stalled body free to hang past `timeoutMs`. Keep it armed until the
  // finally, after body parsing.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/host-catalog`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: "unavailable" };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A body that aborts past the deadline is a timeout, not a malformed
      // payload — classify it as such before treating it as invalid JSON.
      if (controller.signal.aborted) return { ok: false, reason: "timeout" };
      return { ok: false, reason: "invalid" };
    }

    const parsed = hostCompatCatalogEnvelopeSchema.safeParse(body);
    if (!parsed.success) return { ok: false, reason: "invalid" };

    return {
      ok: true,
      catalog: hydrateHostCompatCatalog(parsed.data.catalog),
      version: parsed.data.version,
      contentHash: parsed.data.contentHash,
      publishedAt: parsed.data.publishedAt,
      source: parsed.data.source ?? "live",
    };
  } catch {
    return {
      ok: false,
      reason: controller.signal.aborted ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timer);
  }
}
