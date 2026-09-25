/**
 * Revoked AuthKit sessions, as this process knows them (MJ-011).
 *
 * The backend records every revoked session — an app sign-out, or a revocation
 * the identity provider reports — and lists them on a service-token feed:
 *
 *   GET {CONVEX_HTTP_URL}/internal/v1/auth-sessions/revoked?since=<ms>&cursor=<c>
 *
 * This module keeps an in-process copy of that list so the gateway can refuse
 * a revoked session itself, on the routes that decide authorization here
 * rather than by forwarding the caller's bearer to Convex (which consults the
 * durable record on every request of its own).
 *
 * ## The feed contract, from this side
 *
 * - A SCAN is one or more pages. Its first request carries only `since`; the
 *   response's `cursor` continues the same scan position until a page says
 *   `isDone: true`. That final page, and only that one, carries a `watermark`:
 *   the `since` for the next scan. It deliberately overlaps the previous scan,
 *   so rows are re-read rather than skipped — entries are keyed by session id
 *   and duplicates are expected.
 * - Boot runs a full scan from `since=0`; after that, a scan from the last
 *   watermark every {@link REVOKED_SESSION_POLL_INTERVAL_MS}.
 * - A scan that fails part-way keeps what it learned (a revoked session is
 *   revoked however it was found) but does not move the watermark or the
 *   freshness clock; the next tick starts over from the last complete
 *   watermark.
 * - Entries are dropped once past their `expiresAt`, by which time every
 *   access token the session was issued has expired as well.
 *
 * ## Freshness
 *
 * The copy is FRESH when the last scan that reached `isDone` began no more
 * than {@link REVOKED_SESSION_MAX_STALENESS_MS} ago. The START of that scan is
 * the instant its answer is current as of — anything recorded later may not
 * be in it — so that is what is measured, not when it finished.
 *
 * A session this process knows to be revoked is refused whatever the
 * freshness (see `checkSessionRevocation`). Freshness only decides what
 * happens to a session it has NOT seen: routes that rely on this copy alone
 * refuse to serve while it is incomplete or stale, rather than serving
 * unchecked.
 *
 * ## Where it runs
 *
 * Only in a process that holds `INSPECTOR_SERVICE_TOKEN` and `CONVEX_HTTP_URL`
 * — the hosted deployment. Without them there is no feed to read, and every
 * check here is a no-op: a local or desktop inspector keeps its existing
 * behavior. That costs nothing that works there today, because the routes
 * that act on a caller's behalf over the service channel (API-key management,
 * identity lookups, key bindings) cannot run without the same service token.
 *
 * A HOSTED process started without them is misconfigured, not local: it
 * reports `auth.revoked_sessions.disabled` at startup, and its checks consult
 * a list that never loads, so the routes that rely on it refuse to serve
 * rather than serve unchecked (see `startRevokedSessionCache`).
 */
import { HOSTED_MODE } from "../config.js";
import { getInternalBackendConfig } from "./internal-backend.js";
import { logger } from "../utils/logger.js";

export const REVOKED_SESSIONS_FEED_PATH = "/internal/v1/auth-sessions/revoked";

/** How often a scan runs once the initial load has completed. */
export const REVOKED_SESSION_POLL_INTERVAL_MS = 15_000;

/**
 * How old the last complete scan may be before routes that rely on this copy
 * alone stop serving. Several missed polls, so one slow or failed scan does
 * not take those routes down.
 */
export const REVOKED_SESSION_MAX_STALENESS_MS = 120_000;

/**
 * How long a session marked revoked by THIS process is remembered when the
 * caller does not say. The same floor the backend keeps its own records for;
 * the feed's durable record, once it arrives, carries its own `expiresAt`.
 */
export const REVOKED_SESSION_LOCAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** First retry of a failed initial load; doubles up to the poll interval. */
const INITIAL_LOAD_RETRY_BASE_MS = 1_000;

const FEED_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A runaway guard, not a size limit: a feed that keeps answering `isDone:
 * false` must not pin a scan open forever. At the feed's page size this is far
 * beyond any real revocation list; hitting it fails the scan, visibly.
 */
const MAX_PAGES_PER_SCAN = 5_000;

/** Scan failures are logged at most this often; the stale transition always is. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * Failed initial-load attempts before the stale state is reported. The first
 * retries are seconds apart, so a blip at boot does not page anyone.
 */
const INITIAL_LOAD_FAILURES_BEFORE_REPORT = 3;

export interface RevokedSessionEntry {
  sid: string;
  /** When every token issued for the session has expired. */
  expiresAt?: number;
}

export interface RevokedSessionFeedPage {
  sessions: RevokedSessionEntry[];
  /** Continues this scan; null only on the final page. */
  cursor: string | null;
  isDone: boolean;
  /** The next scan's `since`; non-null only on the final page. */
  watermark: number | null;
}

export type RevokedSessionFeedFetcher = (request: {
  since: number;
  cursor?: string;
}) => Promise<RevokedSessionFeedPage>;

export interface RevokedSessionCacheState {
  /** A scan has reached `isDone` at least once. */
  initialLoadComplete: boolean;
  /** Local start time of the last scan that reached `isDone`. */
  lastCompleteScanAt: number | null;
  /** Initial load incomplete, or the last complete scan is too old. */
  stale: boolean;
  /** The `since` the next scan will send. */
  watermark: number;
  /** Sessions currently remembered as revoked. */
  size: number;
  /** Polling has been started and not stopped. */
  running: boolean;
}

export class RevokedSessionFeedError extends Error {
  readonly status?: number;
  readonly code?: string;
  constructor(
    message: string,
    options: { status?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "RevokedSessionFeedError";
    this.status = options.status;
    this.code = options.code;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate one feed page. The page's STRUCTURE is strict — a final page
 * without a watermark, or an unfinished one without a cursor, cannot be
 * continued safely and fails the scan. Individual rows are lenient in the
 * direction that keeps a revocation: a row without a usable session id cannot
 * refuse anything and is skipped; a row without a usable expiry is kept with
 * the local default.
 */
export function parseRevokedSessionFeedPage(
  body: unknown,
): RevokedSessionFeedPage {
  if (!body || typeof body !== "object") {
    throw new RevokedSessionFeedError(
      "Revoked-session feed page is not an object",
    );
  }
  const { sessions, cursor, isDone, watermark } = body as Record<
    string,
    unknown
  >;
  if (!Array.isArray(sessions) || typeof isDone !== "boolean") {
    throw new RevokedSessionFeedError(
      "Revoked-session feed page is missing `sessions` or `isDone`",
    );
  }
  if (isDone && !isFiniteNumber(watermark)) {
    throw new RevokedSessionFeedError(
      "Revoked-session feed final page carries no watermark",
    );
  }
  if (!isDone && (typeof cursor !== "string" || cursor.length === 0)) {
    throw new RevokedSessionFeedError(
      "Revoked-session feed page is unfinished but carries no cursor",
    );
  }
  const entries: RevokedSessionEntry[] = [];
  for (const row of sessions) {
    if (!row || typeof row !== "object") continue;
    const { sid, expiresAt } = row as Record<string, unknown>;
    if (typeof sid !== "string" || sid.length === 0) continue;
    entries.push(isFiniteNumber(expiresAt) ? { sid, expiresAt } : { sid });
  }
  return {
    sessions: entries,
    cursor: typeof cursor === "string" && cursor.length > 0 ? cursor : null,
    isDone,
    watermark: isDone ? (watermark as number) : null,
  };
}

/** One page of the feed, over the service channel. */
export async function fetchRevokedSessionFeedPage(request: {
  since: number;
  cursor?: string;
}): Promise<RevokedSessionFeedPage> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const url = new URL(
    `${convexUrl.replace(/\/+$/, "")}${REVOKED_SESSIONS_FEED_PATH}`,
  );
  url.searchParams.set("since", String(request.since));
  if (request.cursor !== undefined) {
    url.searchParams.set("cursor", request.cursor);
  }
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-inspector-service-token": serviceToken,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(FEED_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      code?: unknown;
    } | null;
    throw new RevokedSessionFeedError(
      `Revoked-session feed answered ${response.status}`,
      {
        status: response.status,
        code: typeof body?.code === "string" ? body.code : undefined,
      },
    );
  }
  return parseRevokedSessionFeedPage(await response.json());
}

export interface RevokedSessionCacheOptions {
  fetchPage: RevokedSessionFeedFetcher;
  now?: () => number;
  pollIntervalMs?: number;
  maxStalenessMs?: number;
}

export class RevokedSessionCache {
  private readonly fetchPage: RevokedSessionFeedFetcher;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly maxStalenessMs: number;

  /** sid → when the entry may be forgotten. */
  private readonly revoked = new Map<string, number>();
  private watermark = 0;
  private initialLoadComplete = false;
  private lastCompleteScanAt: number | null = null;
  private consecutiveFailures = 0;
  private lastFailureLogAt = Number.NEGATIVE_INFINITY;
  private staleReported = false;
  private inFlight: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(options: RevokedSessionCacheOptions) {
    this.fetchPage = options.fetchPage;
    this.now = options.now ?? (() => Date.now());
    this.pollIntervalMs =
      options.pollIntervalMs ?? REVOKED_SESSION_POLL_INTERVAL_MS;
    this.maxStalenessMs =
      options.maxStalenessMs ?? REVOKED_SESSION_MAX_STALENESS_MS;
  }

  /** Whether `sid` is known to be revoked. Independent of freshness. */
  isRevoked(sid: string): boolean {
    return this.revoked.has(sid);
  }

  /**
   * Remember `sid` as revoked right away, ahead of the feed. For the session
   * this process was just asked to sign out; the durable record that reaches
   * every other replica still comes from the backend.
   */
  markRevokedLocally(sid: string, expiresAt?: number): void {
    if (!sid) return;
    this.remember(
      sid,
      isFiniteNumber(expiresAt)
        ? expiresAt
        : this.now() + REVOKED_SESSION_LOCAL_RETENTION_MS,
    );
  }

  /** Initial load complete, and the last complete scan is recent enough. */
  isFresh(): boolean {
    return !this.isStaleAt(this.now());
  }

  state(): RevokedSessionCacheState {
    return {
      initialLoadComplete: this.initialLoadComplete,
      lastCompleteScanAt: this.lastCompleteScanAt,
      stale: this.isStaleAt(this.now()),
      watermark: this.watermark,
      size: this.revoked.size,
      running: this.running,
    };
  }

  /**
   * Run one scan to completion. Resolves `true` when it reached `isDone`,
   * `false` when it failed; never rejects. A scan already in flight is joined
   * rather than duplicated.
   */
  scan(): Promise<boolean> {
    if (!this.inFlight) {
      this.inFlight = this.runScan().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Begin polling: the initial load now, then a scan every poll interval. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private isStaleAt(now: number): boolean {
    return (
      !this.initialLoadComplete ||
      this.lastCompleteScanAt === null ||
      now - this.lastCompleteScanAt > this.maxStalenessMs
    );
  }

  private remember(sid: string, expiresAt: number | undefined): void {
    const until = isFiniteNumber(expiresAt)
      ? expiresAt
      : this.now() + REVOKED_SESSION_LOCAL_RETENTION_MS;
    const existing = this.revoked.get(sid);
    // Keep the LATER expiry: a duplicate or out-of-order row never shortens
    // how long a session stays refused.
    if (existing === undefined || until > existing) {
      this.revoked.set(sid, until);
    }
  }

  private prune(now: number): void {
    for (const [sid, until] of this.revoked) {
      if (until <= now) this.revoked.delete(sid);
    }
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (!this.running) return;
    await this.scan();
    this.reportStaleness();
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.nextDelay());
    this.timer.unref?.();
  }

  private nextDelay(): number {
    if (this.initialLoadComplete || this.consecutiveFailures === 0) {
      return this.pollIntervalMs;
    }
    // Until the first complete scan, the routes that depend on it refuse to
    // serve, so retry sooner than the steady-state interval.
    return Math.min(
      this.pollIntervalMs,
      INITIAL_LOAD_RETRY_BASE_MS *
        2 ** Math.min(this.consecutiveFailures - 1, 4),
    );
  }

  private async runScan(): Promise<boolean> {
    const startedAt = this.now();
    const since = this.watermark;
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    try {
      while (pages < MAX_PAGES_PER_SCAN) {
        const page = await this.fetchPage(
          cursor === undefined ? { since } : { since, cursor },
        );
        pages += 1;
        for (const entry of page.sessions) {
          this.remember(entry.sid, entry.expiresAt);
        }
        if (page.isDone) {
          if (!isFiniteNumber(page.watermark)) {
            throw new RevokedSessionFeedError(
              "Revoked-session feed final page carries no watermark",
            );
          }
          this.completeScan(startedAt, page.watermark);
          return true;
        }
        if (!page.cursor || seenCursors.has(page.cursor)) {
          throw new RevokedSessionFeedError(
            "Revoked-session feed did not advance its cursor",
          );
        }
        seenCursors.add(page.cursor);
        cursor = page.cursor;
      }
      throw new RevokedSessionFeedError(
        `Revoked-session feed scan exceeded ${MAX_PAGES_PER_SCAN} pages`,
      );
    } catch (error) {
      this.recordFailure(error, pages);
      return false;
    }
  }

  private completeScan(startedAt: number, watermark: number): void {
    const recovered = this.consecutiveFailures > 0 || this.staleReported;
    this.watermark = watermark;
    this.lastCompleteScanAt = startedAt;
    this.initialLoadComplete = true;
    this.consecutiveFailures = 0;
    this.prune(this.now());
    if (recovered) {
      logger.info("Revoked-session list is current again", {
        event: "auth.revoked_sessions.recovered",
        size: this.revoked.size,
      });
    }
    this.staleReported = false;
  }

  private recordFailure(error: unknown, pages: number): void {
    this.consecutiveFailures += 1;
    const now = this.now();
    if (now - this.lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
      this.lastFailureLogAt = now;
      logger.warn("Revoked-session feed scan failed", {
        event: "auth.revoked_sessions.scan_failed",
        consecutiveFailures: this.consecutiveFailures,
        pagesRead: pages,
        status:
          error instanceof RevokedSessionFeedError ? error.status : undefined,
        code: error instanceof RevokedSessionFeedError ? error.code : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * One Sentry-visible line when the list goes stale, not one per request:
   * from then on, the routes that depend on it answer 503 until a scan
   * completes.
   */
  private reportStaleness(): void {
    if (this.staleReported || !this.isStaleAt(this.now())) return;
    if (
      !this.initialLoadComplete &&
      this.consecutiveFailures < INITIAL_LOAD_FAILURES_BEFORE_REPORT
    ) {
      return;
    }
    this.staleReported = true;
    logger.error(
      "Revoked-session list is not current; session-dependent routes are refusing requests",
      new RevokedSessionFeedError("Revoked-session list is stale"),
      {
        event: "auth.revoked_sessions.stale",
        initialLoadComplete: this.initialLoadComplete,
        lastCompleteScanAt: this.lastCompleteScanAt,
        consecutiveFailures: this.consecutiveFailures,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// The process-wide instance
// ---------------------------------------------------------------------------

/** Whether this process can read the feed at all (hosted). */
export function isRevokedSessionFeedConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    env.CONVEX_HTTP_URL?.trim() && env.INSPECTOR_SERVICE_TOKEN?.trim(),
  );
}

let processCache: RevokedSessionCache | null = null;
let testCache: RevokedSessionCache | null | undefined;

/**
 * Set at startup by a hosted process that has no feed to read. Its checks then
 * consult a list that never loads, exactly as while a real one is loading.
 */
let hostedWithoutFeed = false;

function getProcessCache(): RevokedSessionCache {
  processCache ??= new RevokedSessionCache({
    fetchPage: fetchRevokedSessionFeedPage,
  });
  return processCache;
}

/**
 * The cache the checks consult, or null when this process has no feed to read
 * (local / desktop), in which case every check passes.
 */
export function activeRevokedSessionCache(): RevokedSessionCache | null {
  if (testCache !== undefined) return testCache;
  return hostedWithoutFeed || isRevokedSessionFeedConfigured()
    ? getProcessCache()
    : null;
}

/**
 * Start the initial load and polling. Called once at server startup; returns
 * immediately (the load runs in the background) and is idempotent. The routes
 * that depend on the list refuse to serve until the load completes.
 *
 * In a hosted process without the feed's configuration, the load can never
 * complete: this reports it once, and those routes keep refusing (503) until
 * the process is restarted with it. A known revocation — a sign-out on this
 * process — is still refused everywhere.
 */
export function startRevokedSessionCache(): void {
  if (!isRevokedSessionFeedConfigured()) {
    if (HOSTED_MODE && !hostedWithoutFeed) {
      hostedWithoutFeed = true;
      logger.error(
        "Revoked-session list cannot load: CONVEX_HTTP_URL / INSPECTOR_SERVICE_TOKEN missing; session-dependent routes are refusing requests",
        new RevokedSessionFeedError("Revoked-session feed is not configured"),
        { event: "auth.revoked_sessions.disabled" },
      );
    }
    return;
  }
  getProcessCache().start();
}

/** Stop polling (shutdown). */
export function stopRevokedSessionCache(): void {
  processCache?.stop();
}

/**
 * Test-only: make the checks consult `cache` (null: behave as a process with
 * no feed). `undefined` restores the environment-derived behavior.
 */
export function setRevokedSessionCacheForTests(
  cache: RevokedSessionCache | null | undefined,
): void {
  testCache = cache;
}

export type SessionRevocationCheck =
  | { ok: true }
  | { ok: false; reason: "revoked" }
  | { ok: false; reason: "no_session" }
  | { ok: false; reason: "unavailable" };

const SESSION_OK: SessionRevocationCheck = { ok: true };

/**
 * Whether a VERIFIED session may be served.
 *
 * - A session known to be revoked is refused, always — including while the
 *   feed is failing.
 * - With `requireFresh`, a session the list has not seen is refused as
 *   `unavailable` while the list is incomplete or stale. For routes whose
 *   authorization rests on this gateway alone; routes that forward the
 *   caller's bearer to Convex, which checks the durable record itself, pass
 *   `requireFresh: false`.
 * - With `requireFresh`, a token without a session id is refused as
 *   `no_session`: the list cannot vouch for a session it cannot name. Without
 *   it, such a token passes to Convex, which decides.
 * - With no feed configured (local / desktop), everything passes.
 */
export function checkSessionRevocation(
  sid: string | undefined | null,
  options: { requireFresh: boolean },
): SessionRevocationCheck {
  const cache = activeRevokedSessionCache();
  if (!cache) return SESSION_OK;
  if (!sid) {
    return options.requireFresh
      ? { ok: false, reason: "no_session" }
      : SESSION_OK;
  }
  if (cache.isRevoked(sid)) return { ok: false, reason: "revoked" };
  if (options.requireFresh && !cache.isFresh()) {
    return { ok: false, reason: "unavailable" };
  }
  return SESSION_OK;
}

/**
 * Record, in this process, that `sid` was just revoked. A no-op where the
 * checks never consult a list (local / desktop).
 */
export function markSessionRevokedLocally(
  sid: string | undefined | null,
  expiresAt?: number,
): void {
  if (!sid) return;
  activeRevokedSessionCache()?.markRevokedLocally(sid, expiresAt);
}
