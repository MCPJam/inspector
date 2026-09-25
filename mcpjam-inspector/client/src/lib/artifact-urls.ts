/**
 * Short-lived artifact links.
 *
 * Private artifacts (chat transcripts, trace spans and request payloads,
 * captured widget HTML, tool input/output, screenshots, reports) reach the
 * browser as signed links on the backend's HTTP origin
 * (`…/web/artifact?t=…`), minted by the query that authorized the read and
 * valid for one to two hours. Convex re-runs a subscribed query when its data
 * changes, not when time passes, so a page that stays open can end up holding
 * a link that has expired. This module is the client half of that contract:
 *
 *   - Every result that carries artifact links is REGISTERED here
 *     (`useArtifactQuery` does it for subscriptions; action and HTTP loaders
 *     call `registerArtifactUrls`), keyed by the object a link points at, so
 *     the freshest link seen for an object is always known.
 *   - `fetchArtifact` fetches the freshest known link for the object. When the
 *     backend still answers 401/403/404/410 it requests a refresh, waits
 *     briefly for a fresher link to be registered, and retries once. A
 *     refresh makes every `useArtifactQuery` re-subscribe with a new
 *     `urlEpoch`, a cache-buster the backend never reads, which re-runs the
 *     query (authorization included) and mints new links.
 *   - A 404/410 says the object, not the link, is gone, so an object gets one
 *     such renewal until it is read successfully again (MJ-005): an artifact
 *     that really is missing does not keep re-running every query on the page.
 *   - `useFreshArtifactUrl` does the same for `<img>` and `<video>` sources
 *     (see `ArtifactImage`), which cannot see status codes.
 *   - `artifactStableKey` names the object a link points at, so a re-minted
 *     link to the same object is not mistaken for new content.
 *
 * Nothing here renews a link on its own: a fresh link only ever comes from a
 * query or action that re-authorized the reader.
 *
 * Registration scans whole results, and the client cannot check a link's
 * signature, so a registered link is only trusted as far as its ORIGIN: it can
 * stand in for a link on the same origin and nothing else. A string that
 * merely looks like an artifact link (a title, a preview, a message someone
 * else wrote) cannot redirect a fetch or an image to another host.
 *
 * Anything that is not a signed artifact link passes through untouched, so
 * every helper is safe on mixed input.
 */

import { useQuery } from "convex/react";
import { useEffect, useRef, useSyncExternalStore } from "react";

const ARTIFACT_PATH_SUFFIX = "/web/artifact";
/** At most one refresh request per window, however many links fail at once. */
const REFRESH_THROTTLE_MS = 30_000;
/** How long a failed fetch waits for a re-run query to register a new link. */
const RENEWAL_WAIT_MS = 15_000;
/** Registry entries kept before expired ones are swept. */
const REGISTRY_SWEEP_THRESHOLD = 2_000;
/** Nodes visited when scanning one result for links. */
const REGISTER_SCAN_BUDGET = 20_000;
/** Answers that send a fetch to renew its link. */
const RENEWABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 410]);
/** Of those, the answers that say the object itself is missing. */
const MISSING_STATUSES: ReadonlySet<number> = new Set([404, 410]);
/**
 * Renewals an object gets for a missing answer — or, on a media element,
 * which cannot see the status, for a failure on a link that has not expired —
 * before it is next read successfully.
 */
const MISSING_RENEWAL_LIMIT = 1;
/**
 * A media link this close to its expiry is renewed like an expired one, so a
 * clock that runs a little behind the backend's still renews it every time.
 */
const MEDIA_EXPIRY_MARGIN_MS = 10 * 60_000;

// ── Link anatomy ───────────────────────────────────────────────────────────

/** True for a signed artifact link minted by the backend. */
export function isSignedArtifactUrl(
  url: string | null | undefined,
): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.pathname.endsWith(ARTIFACT_PATH_SUFFIX) &&
      parsed.searchParams.has("t")
    );
  } catch {
    return false;
  }
}

type ArtifactClaims = { s: string; k: string; e: number };

/** The signed claims of a link. Read for identity and expiry only; the
 * backend verifies the signature. */
function readClaims(url: string): ArtifactClaims | null {
  if (!isSignedArtifactUrl(url)) return null;
  const token = new URL(url).searchParams.get("t") ?? "";
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/");
  try {
    const parsed: unknown = JSON.parse(
      atob(body + "=".repeat((4 - (body.length % 4)) % 4)),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const { s, k, e } = parsed as Record<string, unknown>;
    return typeof s === "string" &&
      typeof k === "string" &&
      typeof e === "number"
      ? { s, k, e }
      : null;
  } catch {
    return null;
  }
}

/**
 * The registry key for a link: the object it points at, on the origin that
 * served it. The origin is part of the key because the client cannot verify
 * the claims — only a link from the same origin may replace another.
 */
function registryKey(url: string, claims: ArtifactClaims): string {
  return `artifact:${new URL(url).origin}:${claims.k}:${claims.s}`;
}

/**
 * What a link points at, independent of when it expires: two links minted
 * an hour apart for the same object share a key. Anything that is not a
 * signed artifact link is its own key.
 */
export function artifactStableKey(url: string): string {
  const claims = readClaims(url);
  return claims ? registryKey(url, claims) : url;
}

// ── Registry: the freshest link seen for each object ───────────────────────

const freshest = new Map<string, { url: string; expiresAt: number }>();
let registryVersion = 0;
const registryListeners = new Set<() => void>();

function sweepExpired(now: number): void {
  for (const [key, entry] of freshest) {
    if (entry.expiresAt <= now) freshest.delete(key);
  }
}

/** Record one link if it is fresher than what is known for its object. */
function registerOne(url: string): boolean {
  const claims = readClaims(url);
  if (!claims) return false;
  const key = registryKey(url, claims);
  const expiresAt = claims.e * 1000;
  const known = freshest.get(key);
  if (known && known.expiresAt >= expiresAt) return false;
  freshest.set(key, { url, expiresAt });
  return true;
}

/**
 * Record every artifact link found in `value` (a query or action result).
 * Bounded: large results are scanned up to a fixed number of nodes.
 */
export function registerArtifactUrls(value: unknown): void {
  let changed = false;
  let budget = REGISTER_SCAN_BUDGET;
  const stack: unknown[] = [value];
  while (stack.length > 0 && budget > 0) {
    budget -= 1;
    const node = stack.pop();
    if (typeof node === "string") {
      if (node.includes(ARTIFACT_PATH_SUFFIX) && registerOne(node)) {
        changed = true;
      }
    } else if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (node && typeof node === "object") {
      for (const item of Object.values(node)) stack.push(item);
    }
  }
  if (!changed) return;
  if (freshest.size > REGISTRY_SWEEP_THRESHOLD) sweepExpired(Date.now());
  registryVersion += 1;
  for (const listener of registryListeners) listener();
}

/** The freshest known link for the object `url` points at. */
export function freshestArtifactUrl(url: string): string {
  const claims = readClaims(url);
  if (!claims) return url;
  const known = freshest.get(registryKey(url, claims));
  return known && known.expiresAt > claims.e * 1000 ? known.url : url;
}

function subscribeRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

function getRegistryVersion(): number {
  return registryVersion;
}

/** Resolve once a link fresher than `url` is registered, or `null` on timeout. */
function waitForFresherUrl(
  url: string,
  timeoutMs: number,
): Promise<string | null> {
  const current = freshestArtifactUrl(url);
  if (current !== url) return Promise.resolve(current);
  return new Promise((resolve) => {
    const onChange = () => {
      const next = freshestArtifactUrl(url);
      if (next !== url) {
        cleanup();
        resolve(next);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      registryListeners.delete(onChange);
    };
    registryListeners.add(onChange);
  });
}

/**
 * The freshest known link for `url`'s object, re-rendering when a fresher one
 * is registered. Use for `src` attributes.
 */
export function useFreshArtifactUrl<T extends string | null | undefined>(
  url: T,
): T {
  useSyncExternalStore(
    subscribeRegistry,
    getRegistryVersion,
    getRegistryVersion,
  );
  return (typeof url === "string" ? freshestArtifactUrl(url) : url) as T;
}

// ── Refresh ────────────────────────────────────────────────────────────────

let currentEpoch: number | undefined;
let lastRefreshRequestAt = Number.NEGATIVE_INFINITY;
const epochListeners = new Set<() => void>();
/** Missing-object renewals spent, per object (`artifactStableKey`). */
const missingRenewals = new Map<string, number>();

/** Spend one of an object's missing-object renewals, if it has one left. */
function takeMissingRenewal(url: string): boolean {
  const key = artifactStableKey(url);
  const spent = missingRenewals.get(key) ?? 0;
  if (spent >= MISSING_RENEWAL_LIMIT) return false;
  missingRenewals.set(key, spent + 1);
  return true;
}

/** The object was read: it may be renewed again if it later goes missing. */
function restoreMissingRenewals(url: string): void {
  missingRenewals.delete(artifactStableKey(url));
}

/**
 * Ask every artifact-bearing subscription (and loader) to re-run, so it mints
 * fresh links. Throttled: a page full of expired thumbnails produces one
 * refresh, not one per image. Returns whether this call triggered a refresh.
 */
export function requestArtifactUrlRefresh(now: number = Date.now()): boolean {
  if (now - lastRefreshRequestAt < REFRESH_THROTTLE_MS) return false;
  lastRefreshRequestAt = now;
  // Minute-resolution so tabs refreshing together share a server cache
  // entry, and strictly increasing so every refresh re-subscribes.
  currentEpoch = Math.max((currentEpoch ?? 0) + 1, Math.floor(now / 60_000));
  for (const listener of epochListeners) listener();
  return true;
}

function subscribeEpoch(listener: () => void): () => void {
  epochListeners.add(listener);
  return () => {
    epochListeners.delete(listener);
  };
}

function getEpoch(): number | undefined {
  return currentEpoch;
}

/**
 * The current refresh epoch, or `undefined` until a link has expired on this
 * page. Components that load artifacts through an action (rather than a
 * subscription) re-read when this changes.
 */
export function useArtifactUrlEpoch(): number | undefined {
  return useSyncExternalStore(subscribeEpoch, getEpoch, getEpoch);
}

/** Test seam: forget every registered link and refresh request. */
export function resetArtifactUrlsForTests(): void {
  currentEpoch = undefined;
  lastRefreshRequestAt = Number.NEGATIVE_INFINITY;
  freshest.clear();
  missingRenewals.clear();
  registryVersion = 0;
}

// ── Fetching ───────────────────────────────────────────────────────────────

/**
 * `fetch` for artifact links. Reads the freshest known link for the object;
 * if the backend answers 401 (expired), 403 (no longer valid, e.g. after a
 * key rotation), or 404/410 (the object is not where the link points),
 * requests a refresh, waits briefly for a re-run query to register a fresher
 * link and retries once with it. A 404/410 does this once per object until
 * the object is read successfully again. Otherwise returns the response
 * unchanged, so callers keep their own error handling.
 */
export async function fetchArtifact(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const target = freshestArtifactUrl(url);
  // Same call shape as a plain `fetch(url)` when there is no init.
  const response =
    init === undefined ? await fetch(target) : await fetch(target, init);
  if (!isSignedArtifactUrl(target)) return response;
  if (response.ok) {
    restoreMissingRenewals(target);
    return response;
  }
  if (!RENEWABLE_STATUSES.has(response.status)) return response;
  if (MISSING_STATUSES.has(response.status) && !takeMissingRenewal(target)) {
    return response;
  }
  requestArtifactUrlRefresh();
  const renewed = await waitForFresherUrl(target, RENEWAL_WAIT_MS);
  if (!renewed || init?.signal?.aborted) return response;
  const retried =
    init === undefined ? await fetch(renewed) : await fetch(renewed, init);
  if (retried.ok) restoreMissingRenewals(renewed);
  return retried;
}

/**
 * `onError` for an `<img>` / `<video>` showing an artifact link. The element
 * cannot see the status code. A link at or near its expiry requests a
 * (throttled) refresh every time; any other failure is treated like a
 * missing answer and gets the object's one renewal. The fresh link reaches
 * the element through `useFreshArtifactUrl`.
 */
export function handleArtifactMediaError(
  url: string | null | undefined,
  now: number = Date.now(),
): void {
  if (!isSignedArtifactUrl(url)) return;
  const claims = readClaims(url);
  const expiring =
    claims !== null && claims.e * 1000 - now <= MEDIA_EXPIRY_MARGIN_MS;
  if (!expiring && !takeMissingRenewal(url)) return;
  requestArtifactUrlRefresh(now);
}

// ── Subscriptions ──────────────────────────────────────────────────────────

/**
 * `useQuery` for queries whose results carry artifact links. Identical until
 * a link expires somewhere on the page; from then on the arguments carry
 * `urlEpoch`, which re-runs the query on the server. While that re-run is in
 * flight the previous result for the SAME arguments stays on screen, so a
 * refresh never blanks a view. Every result's links are registered.
 *
 * The backend accepts `urlEpoch` on every query it applies to. It is only
 * ever sent after the backend has served an artifact link, i.e. after the
 * backend that understands it is deployed.
 */
export function useArtifactQuery<T>(
  name: string,
  args: Record<string, unknown> | "skip",
): T | undefined {
  const epoch = useArtifactUrlEpoch();
  const queryArgs =
    args === "skip" || epoch === undefined
      ? args
      : { ...args, urlEpoch: epoch };
  const result = useQuery(name as never, queryArgs as never) as T | undefined;
  useEffect(() => {
    if (result !== undefined) registerArtifactUrls(result);
  }, [result]);
  const argsKey = args === "skip" ? null : JSON.stringify(args);
  const previous = useRef<{ argsKey: string; value: T } | null>(null);
  if (argsKey === null) return undefined;
  if (result !== undefined) {
    previous.current = { argsKey, value: result };
    return result;
  }
  return previous.current?.argsKey === argsKey
    ? previous.current.value
    : undefined;
}
