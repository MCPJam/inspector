/**
 * The score summary behind a shared conformance run's link preview, read from
 * the backend's `/web/share/preview`. The backend answers only for a link
 * anyone may open, and only with the fields the card draws.
 *
 * Crawlers fetch the same image many times (X, LinkedIn, Slack and Discord
 * each unfurl on their own, and retry), so rendered cards are kept briefly.
 * A short life keeps a narrowed or rotated link from showing for long.
 */

import type { ConformanceShareCardData } from "@/shared/conformance-share-card";
import { canDrawShareCard } from "@/shared/conformance-share-card";
import { renderConformanceShareCardPng } from "./render.js";

const BACKEND_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 200;

type BackendPreviewSuite = {
  kind?: unknown;
  applicable?: unknown;
  passed?: unknown;
  failed?: unknown;
  couldNotRun?: unknown;
};

type BackendPreview = {
  score?: unknown;
  outcome?: unknown;
  applicable?: unknown;
  passed?: unknown;
  failed?: unknown;
  couldNotRun?: unknown;
  notApplicable?: unknown;
  advisoryCount?: unknown;
  protocolVersion?: unknown;
  suites?: unknown;
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** The backend's preview in the card's shape; null when it has no score. */
export function cardDataFromPreview(
  preview: BackendPreview,
  siteLabel: string | null,
): ConformanceShareCardData | null {
  if (typeof preview.score !== "number" || !Number.isFinite(preview.score)) {
    return null;
  }
  const suites = Array.isArray(preview.suites)
    ? (preview.suites as BackendPreviewSuite[]).flatMap((suite) =>
        typeof suite?.kind === "string"
          ? [
              {
                kind: suite.kind,
                applicable: count(suite.applicable),
                passed: count(suite.passed),
                failed: count(suite.failed),
                couldNotRun: count(suite.couldNotRun),
              },
            ]
          : [],
      )
    : [];
  const data: ConformanceShareCardData = {
    serverName: null,
    score: preview.score,
    outcome:
      typeof preview.outcome === "string" ? preview.outcome : "incomplete",
    applicable: count(preview.applicable),
    passed: count(preview.passed),
    failed: count(preview.failed),
    couldNotRun: count(preview.couldNotRun),
    notApplicable: count(preview.notApplicable),
    advisoryCount: count(preview.advisoryCount),
    protocolVersion:
      typeof preview.protocolVersion === "string"
        ? preview.protocolVersion
        : null,
    suites,
    siteLabel,
  };
  return canDrawShareCard(data) ? data : null;
}

/**
 * The backend could not answer (network failure, timeout, a 5xx or a garbled
 * body). Unlike "no card", this is never cached: the next request asks again.
 */
export class ShareCardUnavailable extends Error {
  constructor(cause: unknown) {
    super("The share preview backend did not answer", { cause });
    this.name = "ShareCardUnavailable";
  }
}

/** The preview, null for a link with no public card; throws when unsure. */
async function fetchLinkPreview(token: string): Promise<BackendPreview | null> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) return null;
  let response: Response;
  try {
    response = await fetch(new URL("/web/share/preview", convexUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceType: "conformanceRun", token }),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
      redirect: "manual",
    });
  } catch (error) {
    throw new ShareCardUnavailable(error);
  }
  const refused = response.status === 400 || response.status === 404;
  if (!response.ok && !refused) {
    throw new ShareCardUnavailable(`HTTP ${response.status}`);
  }
  let body: { ok?: boolean; preview?: BackendPreview } | null;
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    // A 404 that is not the route's own JSON is a backend without the route
    // (not deployed yet), not a link without a card.
    throw new ShareCardUnavailable(error);
  }
  if (refused) {
    // The route's own refusal: no such link, or not one anyone may open.
    if (body?.ok === false) return null;
    throw new ShareCardUnavailable(`HTTP ${response.status}`);
  }
  return body?.ok && body.preview ? body.preview : null;
}

type CacheEntry = { png: Uint8Array | null; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function remember(key: string, png: Uint8Array | null): void {
  cache.delete(key);
  cache.set(key, { png, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test seam. */
export function clearConformanceShareCardCache(): void {
  cache.clear();
}

/** The caller spent its budget of backend lookups (see lookup-limit.ts). */
export class ShareCardLookupLimited extends Error {
  constructor() {
    super("Too many share card lookups");
    this.name = "ShareCardLookupLimited";
  }
}

/**
 * The PNG for a share link, or null when the link has no public preview.
 * `siteLabel` is the host the link lives on, shown in the card's footer; it
 * must come from a fixed set (it is part of the cache key).
 * `admitLookup` is asked only before a backend read, never for a cached card;
 * when it refuses, this throws `ShareCardLookupLimited`. A backend that does
 * not answer throws `ShareCardUnavailable`, and nothing is cached.
 */
export async function conformanceShareCardForToken(
  token: string,
  siteLabel: string | null,
  admitLookup: () => boolean = () => true,
): Promise<Uint8Array | null> {
  const key = `${siteLabel ?? ""}\u0000${token}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.png;
  if (!admitLookup()) throw new ShareCardLookupLimited();

  const preview = await fetchLinkPreview(token);
  const data = preview ? cardDataFromPreview(preview, siteLabel) : null;
  const png = data ? await renderConformanceShareCardPng(data) : null;
  remember(key, png);
  return png;
}
