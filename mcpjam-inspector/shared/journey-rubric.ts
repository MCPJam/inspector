/**
 * Journey rubric shapes + the id-preserving reconciler the authoring form
 * needs.
 *
 * A rubric row is `{ id, label?, predicate }`. The `id` is the row's identity
 * and the predicate is its current definition — which is what makes "did
 * *Quick resolution* get better over the last five runs?" answerable after
 * someone renames the row or retunes its threshold. Mirrors
 * `criterionValidator` in the backend's `convex/lib/gradingConfig.ts`.
 */

import type { Predicate } from "@/shared/eval-matching";

export interface JourneyCriterion {
  /** Opaque, client-minted, stable across edits. Never parsed. */
  id: string;
  /** Author's display name. Absent ⇒ the UI formats the predicate. */
  label?: string;
  predicate: Predicate;
}

/** Mirrors the backend cap in `convex/lib/gradingConfig.ts`. */
export const MAX_RUBRIC_CRITERIA = 25;

/**
 * Mint a criterion id.
 *
 * `crypto.randomUUID` where available; the fallback exists for older
 * embedded webviews and non-secure contexts, where `crypto.randomUUID` is
 * undefined. Uniqueness only has to hold WITHIN one rubric (≤ 25 rows, all
 * minted in one editing session) — the backend enforces exactly that — so the
 * fallback's weaker guarantee is sufficient.
 */
export function mintCriterionId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `crit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Fold a fresh predicate list back onto the criteria that produced it,
 * PRESERVING ids.
 *
 * The predicate editor is list-shaped and knows nothing about ids, so every
 * edit hands back a bare `Predicate[]`. Losing ids here would be silent
 * damage: a criterion whose threshold was nudged would look like a brand-new
 * criterion, breaking its cross-run trend and orphaning every stamped result
 * that referenced it.
 *
 * Three passes, in decreasing confidence:
 *
 *   1. OBJECT IDENTITY — a row the edit did not touch is the same object it
 *      was. This is what makes add and remove safe: survivors are matched by
 *      identity no matter how the indices shifted.
 *   2. POSITION, but ONLY when the length is unchanged. An EDITED row is a
 *      new object at the same index, and pass 1 has already consumed every
 *      untouched row — so with the length equal, an unmatched index can only
 *      be the row that was edited. When the length CHANGED, the list was
 *      added to or removed from and positions past the change point mean
 *      nothing; matching on them would hand a surviving row a dead row's id.
 *      Deliberately no predicate-kind check: retyping a criterion as a
 *      different kind is still the author editing THAT row, and dropping its
 *      id would break exactly the trend continuity the id exists for.
 *   3. MINT — anything still unmatched is genuinely new.
 */
export function reconcileRubricEntries(
  previous: readonly JourneyCriterion[],
  nextPredicates: readonly Predicate[],
): JourneyCriterion[] {
  // Keep the FIRST row per predicate reference, not the last. Two rows can
  // legitimately share one object (a duplicated criterion), and overwriting
  // would hand row 0 row 1's id and mint a fresh one for row 1 — silently
  // swapping which stamped results belong to which row.
  const byIdentity = new Map<Predicate, JourneyCriterion>();
  for (const entry of previous) {
    if (!byIdentity.has(entry.predicate)) byIdentity.set(entry.predicate, entry);
  }

  const claimed = new Set<string>();
  const resolved: Array<JourneyCriterion | null> = nextPredicates.map(
    (predicate) => {
      const match = byIdentity.get(predicate);
      if (!match || claimed.has(match.id)) return null;
      claimed.add(match.id);
      return match;
    },
  );

  if (previous.length === nextPredicates.length) {
    for (let i = 0; i < resolved.length; i += 1) {
      if (resolved[i] !== null) continue;
      const candidate = previous[i];
      if (!candidate || claimed.has(candidate.id)) continue;
      claimed.add(candidate.id);
      resolved[i] = { ...candidate, predicate: nextPredicates[i] };
    }
  }

  return resolved.map(
    (entry, i) => entry ?? { id: mintCriterionId(), predicate: nextPredicates[i] },
  );
}

/**
 * Normalize a rubric for the wire.
 *
 * Blank labels are dropped rather than sent as `""`: an empty label is the
 * author declining to name the row, which is exactly what "absent" means, and
 * persisting `""` would make the UI render an empty chip instead of falling
 * back to the formatted predicate.
 */
export function serializeRubricForWire(
  entries: readonly JourneyCriterion[],
): JourneyCriterion[] {
  return entries.map((entry) => {
    const label = entry.label?.trim();
    return {
      id: entry.id,
      ...(label ? { label } : {}),
      predicate: entry.predicate,
    };
  });
}
