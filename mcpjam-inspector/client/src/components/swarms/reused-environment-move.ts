/**
 * What happens to a REUSED journey's environment when a swarm launches.
 *
 * A persona is pure identity — it carries no environment, host or server
 * field. The fan-out lives on each journey (`journeys.environmentIds`), and a
 * launch may override it for one run without rewriting the shared definition.
 * That override is deliberate: it is what lets "run these six goals against a
 * new environment" avoid mutating six rows that other swarms also launch.
 *
 * It is also invisible, which is the problem this module exists to fix. Adding
 * an existing persona brings its stored goals, the Describe step's pre-filled
 * environment silently wins over the environment those goals were written
 * against, and the run looks correct while the goals chase tools the target
 * does not have. Nothing here changes what launches — it only lets Confirm say
 * so before anyone spends a session on it.
 */

/** A project environment, reduced to what a move notice needs to describe it. */
export type EnvironmentMoveRow = {
  environmentId: string;
  /** Display label, already disambiguated — see `environmentLabelsById`. */
  label: string;
  /** `null` when the row runs the client's own servers rather than a group. */
  serverAttachmentId: string | null;
};

/** One reused persona's goals that the launch would re-stamp. */
export type ReusedEnvironmentMove = {
  /** How many of the persona's goals move. Never zero — `null` says none do. */
  goalCount: number;
  /**
   * Labels of the environments those goals were authored against. EMPTY when
   * none of them resolves to a row the caller holds (archived, or left over
   * from another project), which is a real state the copy must handle rather
   * than a reason to suppress the notice — the move still happens.
   */
  fromLabels: string[];
  /**
   * The moved goals shared no server group with the destination. This is the
   * case worth a caution: goals written against one server's tools are not
   * merely running elsewhere, they are running somewhere those tools are
   * absent.
   */
  differentServerGroup: boolean;
};

/**
 * Whether a reused journey's stored fan-out already IS the selection.
 *
 * Order-insensitive: the fan-out is a set of targets to run, not a sequence
 * that executes, so a reordered-but-identical selection must not trigger an
 * override that says nothing.
 */
export function sameEnvironmentSelection(
  stored: readonly string[] | null,
  selection: readonly string[],
): boolean {
  const current = stored ?? [];
  if (current.length !== selection.length) return false;
  const wanted = new Set(selection);
  return current.every((id) => wanted.has(id));
}

/**
 * Describe the move one reused persona's goals are about to make, or `null`
 * when none of them moves.
 *
 * `storedEnvironmentIds` is one entry per goal, in the shape the journey rows
 * carry it: an array is a stored fan-out, `null` or absent is a LEGACY journey
 * with no environment of its own. A legacy row is never counted as a move —
 * the launch does override it (it has nothing else to run against), but there
 * is no authored environment to move it off, and saying otherwise would invent
 * a history the row never had.
 */
export function describeReusedEnvironmentMove(args: {
  storedEnvironmentIds: readonly (readonly string[] | null | undefined)[];
  selection: readonly string[];
  rowsById: ReadonlyMap<string, EnvironmentMoveRow>;
}): ReusedEnvironmentMove | null {
  const { storedEnvironmentIds, selection, rowsById } = args;
  // No selection ⇒ the launch sends no override and every reused goal runs its
  // own fan-out. Nothing moves, so there is nothing to disclose.
  if (selection.length === 0) return null;

  const fromIds = new Set<string>();
  let goalCount = 0;
  for (const stored of storedEnvironmentIds) {
    if (stored == null) continue;
    if (sameEnvironmentSelection(stored, selection)) continue;
    goalCount += 1;
    for (const environmentId of stored) fromIds.add(environmentId);
  }
  if (goalCount === 0) return null;

  const fromRows = [...fromIds]
    .map((environmentId) => rowsById.get(environmentId))
    .filter((row): row is EnvironmentMoveRow => row !== undefined);

  // Only claim a server-group change when BOTH sides are known and they share
  // no group at all. A stored row the caller never fetched contributes nothing,
  // so an unresolvable origin yields no caution — silence is honest here, a
  // guess is not.
  const toGroups = new Set(
    selection
      .map((environmentId) => rowsById.get(environmentId)?.serverAttachmentId)
      .filter((id): id is string => typeof id === "string"),
  );
  const fromGroups = new Set(
    fromRows
      .map((row) => row.serverAttachmentId)
      .filter((id): id is string => typeof id === "string"),
  );
  const differentServerGroup =
    toGroups.size > 0 &&
    fromGroups.size > 0 &&
    [...fromGroups].every((group) => !toGroups.has(group));

  return {
    goalCount,
    fromLabels: fromRows.map((row) => row.label),
    differentServerGroup,
  };
}
