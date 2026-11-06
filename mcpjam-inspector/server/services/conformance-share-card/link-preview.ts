/**
 * The score summary behind a shared conformance run's link preview, read from
 * the backend's `/internal/v1/shares/link-preview` with the service
 * credential (the same way `routes/web/score.ts` reads score runs). The
 * backend answers only for a link anyone may open, and only with the fields
 * the card draws.
 *
 * Two caches, for two different questions:
 * - May this link show a card? Answered by the backend and kept for 10
 *   seconds, so a narrowed, rotated or revoked link stops showing its card
 *   almost at once, while a burst of crawler fetches costs one lookup.
 * - What does the card look like? A drawn PNG, kept by the summary it was
 *   drawn from. A shared run is a frozen snapshot, so that one can live long,
 *   and a render (headless Chromium) is the expensive part.
 */

import { createHash } from "node:crypto";
import type { ConformanceShareCardData } from "@/shared/conformance-share-card";
import { canDrawShareCard } from "@/shared/conformance-share-card";
import {
  INSPECTOR_SERVICE_TOKEN_HEADER,
  getServiceCredential,
} from "../service-credential.js";
import { renderConformanceShareCardPng } from "./render.js";

const BACKEND_PATH = "/internal/v1/shares/link-preview";
const BACKEND_TIMEOUT_MS = 8_000;
export const SHARE_CARD_LINK_TTL_MS = 10_000;
const CARD_TTL_MS = 6 * 60 * 60_000;
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
  pending?: unknown;
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
    pending: count(preview.pending),
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
 * The backend could not answer (network failure, timeout, a refused
 * credential, a 5xx or a garbled body). Unlike "no card", this is never
 * cached: the next request asks again.
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
  const serviceToken = getServiceCredential();
  // A self-hosted build holds no service credential, and a crawler cannot
  // reach it anyway: no card.
  if (!convexUrl || !serviceToken) return null;
  let response: Response;
  try {
    response = await fetch(new URL(BACKEND_PATH, convexUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INSPECTOR_SERVICE_TOKEN_HEADER]: serviceToken,
      },
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

/** A small map whose entries expire, dropping the oldest past its size. */
class ExpiringCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): { value: T } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return { value: entry.value };
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Per link token: the backend's answer, null for "no card". */
const linkAnswers = new ExpiringCache<BackendPreview | null>(
  SHARE_CARD_LINK_TTL_MS,
);
/** Per drawn card: its PNG (null where there is no Chromium to draw it). */
const drawnCards = new ExpiringCache<Uint8Array | null>(CARD_TTL_MS);
/** Draws in progress, so concurrent fetches of one card share a render. */
const drawing = new Map<string, Promise<Uint8Array | null>>();

/** Test seam. */
export function clearConformanceShareCardCache(): void {
  linkAnswers.clear();
  drawnCards.clear();
  drawing.clear();
}

/** The caller spent its budget of backend lookups (see lookup-limit.ts). */
export class ShareCardLookupLimited extends Error {
  constructor() {
    super("Too many share card lookups");
    this.name = "ShareCardLookupLimited";
  }
}

async function drawCard(
  data: ConformanceShareCardData,
): Promise<Uint8Array | null> {
  const key = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  const drawn = drawnCards.get(key);
  if (drawn) return drawn.value;
  let pending = drawing.get(key);
  if (!pending) {
    pending = renderConformanceShareCardPng(data)
      .then((png) => {
        drawnCards.set(key, png);
        return png;
      })
      .finally(() => drawing.delete(key));
    drawing.set(key, pending);
  }
  return pending;
}

/**
 * The PNG for a share link, or null when the link has no public preview.
 * `siteLabel` is the host the link lives on, shown in the card's footer; it
 * must come from a fixed set (it is part of the drawn card's key).
 * `admitLookup` is asked only before a backend read, never for an answer
 * still fresh; when it refuses, this throws `ShareCardLookupLimited`. A
 * backend that does not answer throws `ShareCardUnavailable`, and nothing is
 * cached.
 */
export async function conformanceShareCardForToken(
  token: string,
  siteLabel: string | null,
  admitLookup: () => boolean = () => true,
): Promise<Uint8Array | null> {
  let preview: BackendPreview | null;
  const known = linkAnswers.get(token);
  if (known) {
    preview = known.value;
  } else {
    if (!admitLookup()) throw new ShareCardLookupLimited();
    preview = await fetchLinkPreview(token);
    linkAnswers.set(token, preview);
  }
  const data = preview ? cardDataFromPreview(preview, siteLabel) : null;
  return data ? drawCard(data) : null;
}
