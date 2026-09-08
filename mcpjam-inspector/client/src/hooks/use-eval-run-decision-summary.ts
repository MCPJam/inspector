/**
 * React access to D9's canonical run decision summary.
 *
 * Every hook here is a THIN subscriber over
 * {@link EvalDecisionSummaryStore}: the store owns dedupe, the global
 * concurrency cap, the LRU and the abort policy, and these own only the
 * component-lifetime concerns — which key is current, and rejecting a paint
 * from a key that is no longer the one being shown.
 *
 * ── Nothing here derives a verdict ───────────────────────────────────────────
 *
 * The pagination hook concatenates DIAGNOSTIC pages and sums the
 * `scannedIterations` those pages reported. It never recomputes a verdict, a
 * count, or a completeness claim: `diagnostics.complete` is the server's word
 * and is exposed verbatim, with the local "we followed every cursor we were
 * given" fact kept beside it under its own name. Those are two different
 * statements and merging them would let a client-side walk upgrade a partial
 * page to a complete failure list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DECISION_SUMMARY_BADGE_LIMIT,
  DECISION_SUMMARY_DETAIL_LIMIT,
  EvalDecisionSummaryStore,
  decisionSummaryKey,
  evalDecisionSummaryStore,
  type DecisionSummaryEntry,
} from "@/lib/evals/eval-decision-summary-store";
import type { EvalRunDecisionSummaryError } from "@/lib/apis/eval-run-decision-summary-api";
import type {
  EvalRunDecisionDiagnostic,
  EvalRunDecisionSummary,
} from "@mcpjam/sdk/contract";

export interface EvalRunDecisionSummaryTarget {
  /** Threaded from `EvaluateTab`. Never resolved or guessed in the browser. */
  projectId: string | null | undefined;
  runId: string | null | undefined;
  /**
   * Off by default at every call site: the flag decides, and a disabled hook
   * issues no request at all.
   */
  enabled: boolean;
  /**
   * An opaque marker for the run row as currently observed. Changing it
   * re-reads immediately — a terminal run's summary can still change when
   * asynchronous judge fanout lands.
   */
  revision?: string;
  /**
   * Whether this view is currently worth revalidating.
   *
   * Separate from `enabled` because the two answer different questions.
   * `enabled` is sticky for a table row — once fetched, keep the answer — but
   * revalidation must follow what is ON SCREEN, or a session that scrolled
   * past three hundred rows would poll all three hundred of them forever.
   * Defaults to `true` for single views (run detail) that are always the thing
   * being looked at.
   */
  revalidate?: boolean;
  /** Test seam. Production always shares the singleton, and must. */
  store?: EvalDecisionSummaryStore;
}

export interface EvalRunDecisionSummaryState {
  status: "disabled" | "loading" | "ready" | "error";
  summary: EvalRunDecisionSummary | null;
  error: EvalRunDecisionSummaryError | null;
}

/**
 * Re-ask the store on the stale window, for as long as the view is mounted.
 *
 * The store evaluates staleness inside `request()`, which means it only ever
 * re-reads when somebody asks. A run-detail page or a visible table row asks
 * once on mount and then sits there — so without this, a summary fetched at
 * T+0 stays on screen indefinitely and asynchronous judge fanout landing at
 * T+2min is never seen. The ticker only ASKS; the store still decides whether
 * the ask becomes a fetch, so a fresh entry costs nothing.
 */
function useStaleRevalidation(
  store: EvalDecisionSummaryStore,
  active: boolean,
  ask: () => void,
): void {
  const askRef = useRef(ask);
  askRef.current = ask;

  useEffect(() => {
    if (!active) return;
    // Ask once on becoming active, not only on the tick. A row scrolled back
    // into view may find its entry evicted, and waiting a whole window to
    // discover that would leave it blank for no reason.
    askRef.current();
    const period = store.staleWindowMs;
    if (!Number.isFinite(period) || period <= 0) return;
    const timer = setInterval(() => askRef.current(), period);
    return () => clearInterval(timer);
  }, [store, active]);
}

function useStoreEntry(
  store: EvalDecisionSummaryStore,
  key: string | null,
): DecisionSummaryEntry | undefined {
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!key) return;
    return store.subscribe(key, () => forceRender((tick) => tick + 1));
  }, [store, key]);

  // Read through the CURRENT key on every render. A response that settles for
  // a key this component has already moved off simply is not read — which is
  // the whole of the out-of-order guard.
  return key ? store.getEntry(key) : undefined;
}

function toState(
  enabled: boolean,
  entry: DecisionSummaryEntry | undefined,
): EvalRunDecisionSummaryState {
  if (!enabled) return { status: "disabled", summary: null, error: null };
  if (!entry) return { status: "loading", summary: null, error: null };
  if (entry.status === "ready") {
    return { status: "ready", summary: entry.summary ?? null, error: null };
  }
  if (entry.status === "error") {
    return { status: "error", summary: null, error: entry.error ?? null };
  }
  return { status: "loading", summary: null, error: null };
}

/**
 * One page of one run's summary — the primitive both the badge hook and the
 * detail walk are built from.
 */
export function useEvalRunDecisionSummaryPage({
  projectId,
  runId,
  enabled,
  revision,
  limit,
  cursor,
  revalidate = true,
  store = evalDecisionSummaryStore,
}: EvalRunDecisionSummaryTarget & {
  limit: number;
  cursor?: string;
}): EvalRunDecisionSummaryState {
  const active = Boolean(enabled && projectId && runId);
  const key = active
    ? decisionSummaryKey({
        projectId: projectId as string,
        runId: runId as string,
        limit,
        ...(cursor ? { cursor } : {}),
      })
    : null;

  const entry = useStoreEntry(store, key);

  const ask = useCallback(() => {
    if (!active) return;
    store.request({
      projectId: projectId as string,
      runId: runId as string,
      limit,
      ...(cursor ? { cursor } : {}),
      ...(revision !== undefined ? { revision } : {}),
    });
  }, [active, store, projectId, runId, limit, cursor, revision]);

  useEffect(() => {
    ask();
  }, [ask]);

  useStaleRevalidation(store, active && revalidate, ask);

  return toState(active, entry);
}

/**
 * The headline only, for a verdict badge in a table row.
 *
 * Limit 1 rather than the detail page size, and the limit is part of the cache
 * key — so a badge read can never be mistaken for (or reused as) the first
 * page of a run-detail walk.
 */
export function useEvalRunDecisionBadge(
  target: EvalRunDecisionSummaryTarget,
): EvalRunDecisionSummaryState {
  return useEvalRunDecisionSummaryPage({
    ...target,
    limit: DECISION_SUMMARY_BADGE_LIMIT,
  });
}

/**
 * Every page's diagnostics in page order, with each iteration listed once.
 *
 * Pages can overlap when a cursor is replayed. An iteration is ONE trial
 * however many pages mention it, and listing it twice would read as two
 * failures.
 */
function dedupeDiagnostics(
  pages: readonly EvalRunDecisionSummary[],
): EvalRunDecisionDiagnostic[] {
  const seen = new Set<string>();
  const items: EvalRunDecisionDiagnostic[] = [];
  for (const page of pages) {
    for (const item of page.diagnostics.items) {
      if (seen.has(item.iterationId)) continue;
      seen.add(item.iterationId);
      items.push(item);
    }
  }
  return items;
}

export interface EvalRunDecisionDetailState {
  status: "disabled" | "loading" | "ready" | "error";
  /** Page one's summary: the verdict, counts, decision and undecided reason. */
  summary: EvalRunDecisionSummary | null;
  error: EvalRunDecisionSummaryError | null;
  /** Every loaded page's diagnostics, in order, deduplicated by iteration id. */
  diagnostics: EvalRunDecisionDiagnostic[];
  /** The sum of `scannedIterations` over the pages actually loaded. */
  scannedIterations: number;
  /**
   * The SERVER's completeness claim from page one, verbatim. Never widened by
   * a local walk and never narrowed by one.
   */
  serverComplete: boolean;
  /** Local fact: every cursor the server offered has been followed. */
  walkExhausted: boolean;
  canLoadMore: boolean;
  isLoadingMore: boolean;
  /** A later page that failed. Earlier pages stay loaded and rendered. */
  pageError: EvalRunDecisionSummaryError | null;
  loadMore: () => void;
  retryFailedPage: () => void;
}

/**
 * The full run-detail read: page one plus every page the reader asks for.
 *
 * Pages are separate cache entries, which is what makes a later-page failure
 * non-destructive — the pages already loaded are still their own valid
 * entries, and nothing about the run's verdict depends on the page that did
 * not arrive.
 */
export function useEvalRunDecisionDetail({
  projectId,
  runId,
  enabled,
  revision,
  revalidate = true,
  store = evalDecisionSummaryStore,
  limit = DECISION_SUMMARY_DETAIL_LIMIT,
}: EvalRunDecisionSummaryTarget & {
  limit?: number;
}): EvalRunDecisionDetailState {
  const active = Boolean(enabled && projectId && runId);
  const [cursors, setCursors] = useState<string[]>([]);
  const [, forceRender] = useState(0);
  const bump = useCallback(() => forceRender((tick) => tick + 1), []);

  // A new run (or project) is a new walk. Without this the second run would
  // inherit the first's cursors, which belong to a different iteration set.
  const identity = `${projectId ?? ""}::${runId ?? ""}::${limit}`;
  const previousIdentity = useRef(identity);
  if (previousIdentity.current !== identity) {
    previousIdentity.current = identity;
    if (cursors.length > 0) setCursors([]);
  }

  const cursorList = useMemo<(string | undefined)[]>(
    () => [undefined, ...cursors],
    [cursors],
  );
  const cursorKey = cursors.join("|");

  const keys = useMemo(
    () =>
      active
        ? cursorList.map((cursor) =>
            decisionSummaryKey({
              projectId: projectId as string,
              runId: runId as string,
              limit,
              ...(cursor ? { cursor } : {}),
            }),
          )
        : [],
    // `cursorKey` stands in for `cursorList`'s identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, projectId, runId, limit, cursorKey],
  );

  const askAllPages = useCallback(() => {
    if (!active) return;
    for (const cursor of cursorList) {
      store.request({
        projectId: projectId as string,
        runId: runId as string,
        limit,
        ...(cursor ? { cursor } : {}),
        ...(revision !== undefined ? { revision } : {}),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, store, projectId, runId, limit, revision, cursorKey]);

  useEffect(() => {
    if (!active) return;
    const releases = keys.map((key) => store.subscribe(key, bump));
    askAllPages();
    return () => {
      for (const release of releases) release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, store, keys, bump, askAllPages]);

  // A run-detail page is exactly the surface someone leaves open while a judge
  // is still landing, so it revalidates every loaded page on the stale window.
  useStaleRevalidation(store, active && revalidate, askAllPages);

  const entries = keys.map((key) => store.getEntry(key));
  const head = entries[0];
  const headState = toState(active, head);

  const readyPages = entries
    .map((entry) => entry?.summary)
    .filter((summary): summary is EvalRunDecisionSummary => Boolean(summary));

  // Recomputed per render rather than memoized: the store's entries are read
  // imperatively, so any dependency list here would be a restatement of "did
  // the store change", which is exactly what the re-render already means.
  const diagnostics = dedupeDiagnostics(readyPages);

  const scannedIterations = readyPages.reduce(
    (sum, page) => sum + page.diagnostics.scannedIterations,
    0,
  );

  const lastEntry = entries[entries.length - 1];
  const lastReady = readyPages[readyPages.length - 1];
  const nextCursor = lastReady?.diagnostics.nextCursor;
  const walkExhausted = Boolean(lastReady) && nextCursor === undefined;
  const tailError =
    entries.length > 1 && lastEntry?.status === "error"
      ? (lastEntry.error ?? null)
      : null;

  const loadMore = useCallback(() => {
    if (!nextCursor) return;
    setCursors((current) =>
      current.includes(nextCursor) ? current : [...current, nextCursor],
    );
  }, [nextCursor]);

  const retryFailedPage = useCallback(() => {
    const failedIndex = entries.findIndex(
      (entry) => entry?.status === "error",
    );
    if (failedIndex < 0) return;
    store.invalidate(keys[failedIndex]);
    const cursor = cursorList[failedIndex];
    store.request({
      projectId: projectId as string,
      runId: runId as string,
      limit,
      ...(cursor ? { cursor } : {}),
      ...(revision !== undefined ? { revision } : {}),
    });
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, keys, cursorList, store, projectId, runId, limit, revision, bump]);

  return {
    status: headState.status,
    summary: headState.summary,
    error: headState.error,
    diagnostics,
    scannedIterations,
    // VERBATIM. See the field's docblock and this module's header.
    serverComplete: headState.summary?.diagnostics.complete ?? false,
    walkExhausted,
    canLoadMore: Boolean(nextCursor),
    isLoadingMore: entries.length > 1 && lastEntry?.status === "loading",
    pageError: tailError,
    loadMore,
    retryFailedPage,
  };
}

/**
 * "Has this row been on screen yet?" — the gate every per-row summary read
 * sits behind.
 *
 * STICKY on purpose. A row that flickers past the viewport edge must not
 * start and abort a request on every scroll frame, so once a row has been
 * seen it stays subscribed for as long as it is mounted. What this bounds is
 * the burst: a 50-row page paints without 50 reads, and "Load more" adds rows
 * that cost nothing until someone scrolls to them.
 */
export function useHasBeenVisible<T extends Element>(options?: {
  rootMargin?: string;
}): [(node: T | null) => void, boolean, boolean] {
  const [visible, setVisible] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const rootMargin = options?.rootMargin ?? "200px";

  const ref = useCallback(
    (node: T | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node) return;
      if (typeof IntersectionObserver === "undefined") {
        // No observer (older jsdom, exotic embedders): treat the row as
        // visible rather than never loading it.
        setVisible(true);
        setOnScreen(true);
        return;
      }
      // Kept CONNECTED rather than disconnected on first intersection. The
      // sticky flag above is the fetch gate; this second, live flag is what
      // lets a caller revalidate only the rows a person is actually looking
      // at. Without it, every row ever scrolled past would keep polling.
      const observer = new IntersectionObserver(
        (entries) => {
          const intersecting = entries.some((entry) => entry.isIntersecting);
          setOnScreen(intersecting);
          if (intersecting) setVisible(true);
        },
        { rootMargin },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [rootMargin],
  );

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    },
    [],
  );

  return [ref, visible, onScreen];
}
