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
  hostIds?: string[];
  serverAttachmentId?: string | null;
};

export type GoalTarget = {
  environmentIds: string[];
  hostIds: string[];
  serverAttachmentId?: string;
};

/** Order-independent, so the same fan-out picked twice counts as one target. */
function targetKey(environmentIds: string[]): string {
  return [...environmentIds].sort().join(" ");
}

export function inheritedGoalTarget(
  goals: readonly GoalWithTarget[] | undefined,
): GoalTarget | null {
  if (!goals) return null;
  const counts = new Map<string, { target: GoalTarget; count: number }>();
  for (const goal of goals) {
    const environmentIds = goal.environmentIds ?? [];
    const target: GoalTarget = environmentIds.length
      ? { environmentIds: [...environmentIds], hostIds: [] }
      : {
          environmentIds: [],
          hostIds: [...(goal.hostIds ?? [])],
          ...(goal.serverAttachmentId
            ? { serverAttachmentId: goal.serverAttachmentId }
            : {}),
        };
    const key = environmentIds.length
      ? `environment:${targetKey(environmentIds)}`
      : `legacy:${targetKey(target.hostIds)}:${target.serverAttachmentId ?? ""}`;
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { target, count: 1 });
  }
  let best: { target: GoalTarget; count: number } | null = null;
  for (const entry of counts.values()) {
    if (best === null || entry.count > best.count) best = entry;
  }
  return best?.target ?? null;
}
