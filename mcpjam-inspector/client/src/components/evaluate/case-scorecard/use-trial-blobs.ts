/**
 * Read the traces of a batch of trials, bounded and cached.
 *
 * The engine's Tier 2 facts — the final answer, tool errors, which tools ran
 * in which turn — live in the trace blob, one action call per trial. A batch
 * can be large, so this caps how many it reads and says so; the alternative
 * is a page that silently fires a dozen calls, or one that silently offers
 * fewer checks without explaining why.
 *
 * A terminal iteration's blob never changes, so the cache is keyed by id
 * alone and survives tab switches. Failed promises are evicted so a retry can
 * happen the next time the identity changes.
 */

import { useAction } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EvalIteration } from "@/components/evals/types";
import type { TraceEnvelope } from "@/components/evals/trace-viewer-adapter";

export type TrialBlobRead =
  | { state: "ok"; blob: TraceEnvelope }
  | { state: "failed"; error: string }
  | { state: "pending" }
  | { state: "skipped" };

const CACHE = new Map<string, Promise<TraceEnvelope>>();
const CACHE_LIMIT = 32;

/** Tests only: the cache outlives a component, so it has to be resettable. */
export function clearTrialBlobCache(): void {
  CACHE.clear();
}

function remember(id: string, promise: Promise<TraceEnvelope>) {
  CACHE.set(id, promise);
  if (CACHE.size > CACHE_LIMIT) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
}

export function useTrialBlobs({
  iterations,
  seed,
  max = 5,
  enabled,
}: {
  iterations: EvalIteration[];
  /** The trial already loaded on this page; never fetched again. */
  seed?: { iterationId: string; blob: TraceEnvelope } | null;
  max?: number;
  enabled: boolean;
}): {
  reads: ReadonlyMap<string, TrialBlobRead>;
  loading: boolean;
  capped: number;
} {
  const getBlob = useAction(
    "testSuites:getTestIterationBlob" as never,
  ) as unknown as (args: { iterationId: string }) => Promise<TraceEnvelope>;

  const [reads, setReads] = useState<ReadonlyMap<string, TrialBlobRead>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);

  // Same gate `useEvalTraceBlob` uses: with neither source there is nothing
  // for the backend to resolve, so the roundtrip is skipped.
  const eligible = useMemo(
    () => iterations.filter((it) => it.blob || it.chatSessionId),
    [iterations],
  );
  const fetchIds = useMemo(
    () =>
      [...eligible]
        .sort((a, b) => a.iterationNumber - b.iterationNumber)
        .slice(0, max)
        .map((it) => it._id),
    [eligible, max],
  );
  const skipped = useMemo(
    () =>
      new Set(
        iterations.map((it) => it._id).filter((id) => !fetchIds.includes(id)),
      ),
    [iterations, fetchIds],
  );
  const capped = Math.max(0, eligible.length - fetchIds.length);

  const getBlobRef = useRef(getBlob);
  getBlobRef.current = getBlob;
  const identity = fetchIds.join("|");
  const seedId = seed?.iterationId;
  /**
   * The seeded blob rides a ref, never the effect's deps.
   *
   * Callers build `{ iterationId, blob }` inline, so the object is new on
   * every render. In the deps that is an infinite loop: the effect sets state,
   * the re-render makes a new object, the dep changed, the effect runs again.
   * The id is the identity that matters — a terminal iteration's blob is
   * immutable — so the id keys the effect and the value is read through here.
   */
  const seedBlobRef = useRef(seed?.blob);
  seedBlobRef.current = seed?.blob;

  useEffect(() => {
    if (!enabled || fetchIds.length === 0) {
      setReads(new Map());
      setLoading(false);
      return;
    }
    let cancelled = false;

    const seeded = seedBlobRef.current;
    if (seedId && seeded && fetchIds.includes(seedId) && !CACHE.has(seedId)) {
      remember(seedId, Promise.resolve(seeded));
    }

    const initial = new Map<string, TrialBlobRead>();
    for (const id of skipped) initial.set(id, { state: "skipped" });
    for (const id of fetchIds) initial.set(id, { state: "pending" });
    setReads(initial);
    setLoading(true);

    void Promise.allSettled(
      fetchIds.map((id) => {
        const cached = CACHE.get(id);
        if (cached) return cached;
        const promise = getBlobRef.current({ iterationId: id });
        remember(id, promise);
        // A rejected promise must not stick in the cache, or the retry the
        // next identity change would have made is answered from the failure.
        promise.catch(() => {
          if (CACHE.get(id) === promise) CACHE.delete(id);
        });
        return promise;
      }),
    ).then((settled) => {
      if (cancelled) return;
      const next = new Map<string, TrialBlobRead>(initial);
      settled.forEach((outcome, index) => {
        const id = fetchIds[index]!;
        next.set(
          id,
          outcome.status === "fulfilled"
            ? { state: "ok", blob: outcome.value }
            : {
                state: "failed",
                error:
                  (outcome.reason as { message?: string })?.message ??
                  "Failed to load trace",
              },
        );
      });
      setReads(next);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // `skipped` is derived from the same inputs as `identity`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, identity, seedId]);

  return { reads, loading, capped };
}
