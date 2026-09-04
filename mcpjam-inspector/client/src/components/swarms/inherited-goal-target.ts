/**
 * Where a persona's next goal should run: wherever its existing goals run.
 *
 * A sibling goal carries a choice the user made explicitly when generating,
 * scoped to this persona rather than guessed from the project. The MOST COMMON
 * target wins, so one experiment against the wrong setup does not redirect
 * everything after it.
 */

export type GoalWithTarget = {
  environmentIds?: string[] | null;
};

/** Order-independent, so the same fan-out picked twice counts as one target. */
function targetKey(environmentIds: string[]): string {
  return [...environmentIds].sort().join(" ");
}

export function inheritedGoalTarget(
  goals: readonly GoalWithTarget[] | undefined,
  /**
   * Live environment ids. A sibling pointing at an archived or deleted one is
   * skipped: nothing validates an inherited target downstream, so copying it
   * would create a goal that can never launch. `undefined` means the list is
   * unknown, and an unmeasurable target is kept rather than dropped.
   */
  liveEnvironmentIds?: ReadonlySet<string>,
): string[] | null {
  if (!goals) return null;
  const counts = new Map<string, { ids: string[]; count: number }>();
  for (const goal of goals) {
    const ids = goal.environmentIds;
    if (!ids || ids.length === 0) continue;
    // Partly-live is not the target the sibling ran, so it is not inheritable.
    if (liveEnvironmentIds && !ids.every((id) => liveEnvironmentIds.has(id))) {
      continue;
    }
    const key = targetKey(ids);
    const seen = counts.get(key);
    // First occurrence wins, so a tie resolves to whichever target the caller
    // listed first. The query's own order decides which that is.
    if (seen) seen.count += 1;
    else counts.set(key, { ids: [...ids], count: 1 });
  }
  let best: { ids: string[]; count: number } | null = null;
  for (const entry of counts.values()) {
    if (best === null || entry.count > best.count) best = entry;
  }
  return best?.ids ?? null;
}
