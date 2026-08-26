/**
 * One request/cache controller for D9's canonical run decision summary,
 * shared by every surface that reads one.
 *
 * ── Why a controller and not three `useEffect`s ──────────────────────────────
 *
 * Three surfaces read this contract — run detail, the Evaluate suite run
 * history, and the project Runs table — and two of them read it PER ROW. A
 * per-component fetch means a 50-row page is 50 requests the moment it paints,
 * a "Show all" is the whole history at once, and a row visible in two places
 * is fetched twice. The client has no query library to lean on, so this is the
 * smallest thing that makes those three surfaces safe together: one cache, one
 * in-flight map, one global concurrency cap.
 *
 * ── The rules it enforces, and what each one is protecting ───────────────────
 *
 *   - **Dedupe by page key** (project, run, limit, cursor). Two subscribers on
 *     the same page share one request.
 *   - **A GLOBAL cap of four active requests.** Not per-surface: the burst this
 *     prevents is a table's worth of rows, and a per-component budget is no
 *     budget at all.
 *   - **A bounded LRU.** A long session scrolling a runs table would otherwise
 *     retain every summary it ever painted.
 *   - **Abort on the LAST subscriber leaving, never the first.** A row that
 *     scrolls out while another surface still wants the same page must not
 *     cancel that page.
 *   - **A stale window, because a terminal run's summary is not frozen.** Judge
 *     fanout is asynchronous: a run that reads `failed` with a pending judge
 *     can legitimately read differently minutes later. Caching a terminal
 *     summary forever would pin the first answer on screen. Refetch after the
 *     window, and immediately when the observed run row's `revision` changes.
 *   - **Errors are not retried in a loop.** `notFound`, `routeUnavailable` and
 *     `invalidContract` are answers, not blips: they are cached and left alone
 *     until something actually changes. Only `requestFailed` ages out.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────────
 *
 * It knows nothing about run lifecycle, verdicts, or rendering. Callers decide
 * whether a run is terminal (see {@link isTerminalEvalRunStatus}) and nothing
 * here ever derives, aggregates, or repairs a summary — it stores exactly what
 * the contract validated, or exactly why there is none.
 */
import {
  EvalRunDecisionSummaryError,
  fetchEvalRunDecisionSummary,
} from "@/lib/apis/eval-run-decision-summary-api";
import type { EvalRunDecisionSummary } from "@mcpjam/sdk/contract";

/** Global ceiling on decision-summary reads in flight at once. */
export const DECISION_SUMMARY_MAX_ACTIVE_REQUESTS = 4;
/** Bounded LRU of run/page entries. */
export const DECISION_SUMMARY_CACHE_LIMIT = 200;
/** How long a cached summary is trusted before a subscriber refetches it. */
export const DECISION_SUMMARY_STALE_MS = 30_000;
/**
 * A verdict badge needs the headline, not the failures. Limit 1 keeps the
 * per-row read as small as the contract allows — and because the limit is part
 * of the cache key, a badge response can never be mistaken for the first page
 * of a detail walk.
 */
export const DECISION_SUMMARY_BADGE_LIMIT = 1;
/** Fixed detail page size. Pagination appends; it never widens the page. */
export const DECISION_SUMMARY_DETAIL_LIMIT = 25;

/** Run lifecycle states that can carry a decision summary worth reading. */
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * Whether this run has stopped.
 *
 * A pending or running row is lifecycle-only on every surface: asking for its
 * decision summary spends a request to be told `notEstablished`, once per
 * poll, for as long as the run lasts.
 */
export function isTerminalEvalRunStatus(
  status: string | null | undefined,
): boolean {
  return typeof status === "string" && TERMINAL_RUN_STATUSES.has(status);
}

/**
 * A marker for "this run row, as currently observed".
 *
 * A terminal run's decision summary is NOT frozen: asynchronous judge fanout
 * can land minutes after the run stopped and change what the run decided. Each
 * field here is one whose change means a cached page describes an older
 * reading — so a changed marker re-reads immediately rather than waiting out
 * the stale window.
 *
 * Structurally typed rather than taking an `EvalSuiteRun`, so the project runs
 * table's explicit row projection (which carries only a subset) satisfies it
 * without anyone reaching for a partial run.
 */
export function evalRunDecisionRevision(run: {
  status: string;
  result?: string | null;
  completedAt?: number | null;
  verdictPolicyVersion?: unknown;
  verdictSummary?: unknown;
  goalCompletionStatus?: string | null;
}): string {
  return [
    run.status,
    run.result ?? "",
    run.completedAt ?? "",
    run.verdictPolicyVersion === undefined
      ? ""
      : String(run.verdictPolicyVersion),
    run.verdictSummary ? "decided" : "",
    run.goalCompletionStatus ?? "",
  ].join("::");
}

export interface DecisionSummaryRequest {
  projectId: string;
  runId: string;
  limit: number;
  cursor?: string;
  /**
   * An opaque marker for the run row this page was read for. When the
   * observed row changes (a judge landed, the run finalized), passing a new
   * revision invalidates the cached page immediately rather than at the end
   * of the stale window.
   */
  revision?: string;
}

export type DecisionSummaryEntryStatus = "loading" | "ready" | "error";

export interface DecisionSummaryEntry {
  status: DecisionSummaryEntryStatus;
  summary?: EvalRunDecisionSummary;
  error?: EvalRunDecisionSummaryError;
  /** When the settled entry was written. `0` while loading. */
  fetchedAt: number;
  revision?: string;
}

/** The page key. Limit and cursor are part of it — see the badge note above. */
export function decisionSummaryKey(request: {
  projectId: string;
  runId: string;
  limit: number;
  cursor?: string;
}): string {
  return [
    request.projectId,
    request.runId,
    String(request.limit),
    request.cursor ?? "",
  ].join("::");
}

type Listener = () => void;

interface PendingRecord {
  key: string;
  request: DecisionSummaryRequest;
  controller: AbortController;
  /** Set when the last subscriber left; a cancelled record never writes. */
  cancelled: boolean;
  /** Queued but not started — still holds a slot in `queue`. */
  queued: boolean;
  /**
   * The newest revision asked for while this record was in flight. When it
   * differs from the record's own, the settle re-requests rather than leaving
   * a knowingly stale entry cached.
   */
  wantedRevision?: string;
}

export type DecisionSummaryFetcher = typeof fetchEvalRunDecisionSummary;

export interface EvalDecisionSummaryStoreOptions {
  fetcher?: DecisionSummaryFetcher;
  now?: () => number;
  maxActiveRequests?: number;
  cacheLimit?: number;
  staleMs?: number;
}

export class EvalDecisionSummaryStore {
  private readonly fetcher: DecisionSummaryFetcher;
  private readonly now: () => number;
  private readonly maxActiveRequests: number;
  private readonly cacheLimit: number;
  private readonly staleMs: number;

  /** Insertion-ordered, re-inserted on read — the Map IS the LRU. */
  private readonly cache = new Map<string, DecisionSummaryEntry>();
  private readonly pending = new Map<string, PendingRecord>();
  private readonly subscribers = new Map<string, Set<Listener>>();
  private queue: PendingRecord[] = [];
  private active = 0;

  constructor(options: EvalDecisionSummaryStoreOptions = {}) {
    this.fetcher = options.fetcher ?? fetchEvalRunDecisionSummary;
    this.now = options.now ?? (() => Date.now());
    this.maxActiveRequests =
      options.maxActiveRequests ?? DECISION_SUMMARY_MAX_ACTIVE_REQUESTS;
    this.cacheLimit = options.cacheLimit ?? DECISION_SUMMARY_CACHE_LIMIT;
    this.staleMs = options.staleMs ?? DECISION_SUMMARY_STALE_MS;
  }

  /** Active (not queued) requests, for tests and for the concurrency cap. */
  get activeRequestCount(): number {
    return this.active;
  }

  get queuedRequestCount(): number {
    return this.queue.length;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  getEntry(key: string): DecisionSummaryEntry | undefined {
    return this.cache.get(key);
  }

  subscribe(key: string, listener: Listener): () => void {
    const existing = this.subscribers.get(key);
    if (existing) existing.add(listener);
    else this.subscribers.set(key, new Set([listener]));

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const set = this.subscribers.get(key);
      if (!set) return;
      set.delete(listener);
      if (set.size > 0) return;
      this.subscribers.delete(key);
      // LAST subscriber, not the first: another surface may still be showing
      // this same page.
      this.cancel(key);
    };
  }

  /**
   * Ask for a page. Idempotent: a fresh cached entry, or an identical request
   * already in flight, does nothing.
   */
  request(request: DecisionSummaryRequest): void {
    const key = decisionSummaryKey(request);

    const inFlight = this.pending.get(key);
    if (inFlight) {
      inFlight.wantedRevision = request.revision;
      return;
    }

    const cached = this.cache.get(key);
    if (cached && !this.isStale(cached, request.revision)) {
      // Touch for the LRU: a page a surface still cares about is not the one
      // to evict.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return;
    }

    this.start(key, request);
  }

  /** Drop a cached page so the next `request` re-reads it. */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /** Test seam: forget everything and cancel every outstanding read. */
  reset(): void {
    for (const record of this.pending.values()) {
      record.cancelled = true;
      record.controller.abort();
    }
    this.pending.clear();
    this.queue = [];
    this.active = 0;
    this.cache.clear();
    this.subscribers.clear();
  }

  private isStale(entry: DecisionSummaryEntry, revision?: string): boolean {
    if (entry.status === "loading") return false;
    if (entry.revision !== revision) return true;
    if (entry.status === "error") {
      // An answer, not a blip: a run that is not there, a deployment that does
      // not serve the contract, and a payload that did not validate are all
      // still true on the next render. Only a failed READ ages out.
      return (
        entry.error?.kind === "requestFailed" &&
        this.now() - entry.fetchedAt >= this.staleMs
      );
    }
    return this.now() - entry.fetchedAt >= this.staleMs;
  }

  private start(key: string, request: DecisionSummaryRequest): void {
    const record: PendingRecord = {
      key,
      request,
      controller: new AbortController(),
      cancelled: false,
      queued: true,
      wantedRevision: request.revision,
    };
    this.pending.set(key, record);
    this.write(key, {
      status: "loading",
      fetchedAt: 0,
      revision: request.revision,
    });
    this.queue.push(record);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.maxActiveRequests && this.queue.length > 0) {
      const record = this.queue.shift();
      if (!record) return;
      record.queued = false;
      if (record.cancelled) continue;
      this.active += 1;
      void this.run(record);
    }
  }

  private async run(record: PendingRecord): Promise<void> {
    let entry: DecisionSummaryEntry;
    try {
      const summary = await this.fetcher(
        {
          projectId: record.request.projectId,
          runId: record.request.runId,
          limit: record.request.limit,
          ...(record.request.cursor ? { cursor: record.request.cursor } : {}),
        },
        record.controller.signal,
      );
      entry = {
        status: "ready",
        summary,
        fetchedAt: this.now(),
        revision: record.request.revision,
      };
    } catch (error) {
      entry = {
        status: "error",
        error:
          error instanceof EvalRunDecisionSummaryError
            ? error
            : new EvalRunDecisionSummaryError(
                "requestFailed",
                error instanceof Error ? error.message : String(error),
                { cause: error },
              ),
        fetchedAt: this.now(),
        revision: record.request.revision,
      };
    } finally {
      this.active -= 1;
      if (this.pending.get(record.key) === record) {
        this.pending.delete(record.key);
      }
    }

    if (record.cancelled) {
      // Abandoned mid-flight: leave no entry behind so a returning subscriber
      // re-reads rather than painting a half-cancelled state.
      this.cache.delete(record.key);
      this.pump();
      return;
    }

    this.write(record.key, entry);
    this.pump();

    if (record.wantedRevision !== record.request.revision) {
      // The row moved under us while this was in flight. The entry we just
      // wrote is knowingly stale, so read the newer one.
      this.request({ ...record.request, revision: record.wantedRevision });
    }
  }

  private cancel(key: string): void {
    const record = this.pending.get(key);
    if (!record) return;
    record.cancelled = true;
    this.pending.delete(key);
    if (record.queued) {
      this.queue = this.queue.filter((queued) => queued !== record);
    }
    record.controller.abort();
    this.cache.delete(key);
  }

  private write(key: string, entry: DecisionSummaryEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.evict();
    const listeners = this.subscribers.get(key);
    if (!listeners) return;
    for (const listener of [...listeners]) listener();
  }

  private evict(): void {
    if (this.cache.size <= this.cacheLimit) return;
    for (const key of [...this.cache.keys()]) {
      if (this.cache.size <= this.cacheLimit) return;
      // Never evict a page something is currently showing — that would evict
      // the entry and immediately refetch it.
      if (this.subscribers.has(key)) continue;
      this.cache.delete(key);
    }
  }
}

/**
 * The process-wide store.
 *
 * A singleton because the concurrency cap is only a cap if every surface
 * shares it. Tests construct their own {@link EvalDecisionSummaryStore}.
 */
export const evalDecisionSummaryStore = new EvalDecisionSummaryStore();
