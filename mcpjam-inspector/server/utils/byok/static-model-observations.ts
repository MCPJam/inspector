import type {
  ByokListResult,
  ByokListedModel,
  ByokProviderAdapter,
} from "./types.js";

/**
 * Reconciling the reviewed static BYOK list (`SUPPORTED_MODELS`) with what a
 * provider's live list reports.
 *
 * A static id the live list does not report is RECORDED as a miss, not
 * removed. It is removed only once a second, separate observation (at least
 * {@link DEFAULT_MIN_MISS_INTERVAL_MS} after the first) still does not report
 * it. One answer can be wrong for reasons that say nothing about the model: a
 * key scoped to a project, a partial rollout, a provider hiccup. A model the
 * live list reports again clears its record.
 *
 * Only a successful, complete, non-empty `provider-list` answer is evidence.
 * A failed call, an answer the adapter stopped paging through, an empty list,
 * and a connection's own configured ids change nothing, so an outage can
 * never mass-remove the static list.
 *
 * State is per process and per scope (a connection: `local:openai`,
 * `org:<provider row id>`); nothing is persisted and no key is involved.
 */

export const MISSES_BEFORE_REMOVAL = 2;
export const DEFAULT_MIN_MISS_INTERVAL_MS = 60 * 60 * 1000;

export type StaticModelMiss = {
  nativeId: string;
  misses: number;
  firstMissedAt: number;
  lastMissedAt: number;
};

export type StaticModelObservation = {
  /** False when the answer was not evidence (see the module comment). */
  recorded: boolean;
  skippedReason?:
    "list_failed" | "list_incomplete" | "list_empty" | "configured_source";
  /** Static ids currently recorded as missing (including removed ones). */
  missing: StaticModelMiss[];
  /** Static ids missing on at least {@link MISSES_BEFORE_REMOVAL} observations. */
  removed: string[];
};

/** Whether the live list still serves a static native id. */
export function isStaticIdServed(
  adapter: ByokProviderAdapter,
  staticId: string,
  listed: readonly ByokListedModel[],
): boolean {
  const canonical = adapter.toCanonicalId(staticId);
  return listed.some(
    (model) =>
      model.nativeId === staticId ||
      (canonical !== undefined && model.canonicalId === canonical) ||
      adapter.isSnapshotOf?.(model.nativeId, staticId) === true,
  );
}

export class StaticModelObservationStore {
  private readonly byScope = new Map<string, Map<string, StaticModelMiss>>();
  private readonly minMissIntervalMs: number;

  constructor(options: { minMissIntervalMs?: number } = {}) {
    this.minMissIntervalMs =
      options.minMissIntervalMs ?? DEFAULT_MIN_MISS_INTERVAL_MS;
  }

  observe(
    scope: string,
    adapter: ByokProviderAdapter,
    staticIds: readonly string[],
    result: ByokListResult,
  ): StaticModelObservation {
    const skip = (
      skippedReason: NonNullable<StaticModelObservation["skippedReason"]>,
    ): StaticModelObservation => ({
      recorded: false,
      skippedReason,
      ...this.snapshot(scope, staticIds),
    });
    if (!result.ok) return skip("list_failed");
    if (result.source !== "provider-list") return skip("configured_source");
    if (!result.complete) return skip("list_incomplete");
    if (result.models.length === 0) return skip("list_empty");

    const records =
      this.byScope.get(scope) ?? new Map<string, StaticModelMiss>();
    for (const staticId of staticIds) {
      if (isStaticIdServed(adapter, staticId, result.models)) {
        records.delete(staticId);
        continue;
      }
      const at = result.observedAt;
      const prior = records.get(staticId);
      if (!prior) {
        records.set(staticId, {
          nativeId: staticId,
          misses: 1,
          firstMissedAt: at,
          lastMissedAt: at,
        });
      } else if (at - prior.lastMissedAt >= this.minMissIntervalMs) {
        records.set(staticId, {
          ...prior,
          misses: prior.misses + 1,
          lastMissedAt: at,
        });
      }
      // Otherwise the same outage/answer seen again: not a new observation.
    }
    this.byScope.set(scope, records);
    return { recorded: true, ...this.snapshot(scope, staticIds) };
  }

  /** Static ids to drop for this scope. */
  removedIds(scope: string): Set<string> {
    const out = new Set<string>();
    for (const record of this.byScope.get(scope)?.values() ?? []) {
      if (record.misses >= MISSES_BEFORE_REMOVAL) out.add(record.nativeId);
    }
    return out;
  }

  reset(): void {
    this.byScope.clear();
  }

  private snapshot(
    scope: string,
    staticIds: readonly string[],
  ): Pick<StaticModelObservation, "missing" | "removed"> {
    const records = this.byScope.get(scope);
    const missing: StaticModelMiss[] = [];
    const removed: string[] = [];
    for (const id of staticIds) {
      const record = records?.get(id);
      if (!record) continue;
      missing.push({ ...record });
      if (record.misses >= MISSES_BEFORE_REMOVAL) removed.push(id);
    }
    return { missing, removed };
  }
}
