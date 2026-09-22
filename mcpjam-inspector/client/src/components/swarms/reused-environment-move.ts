/**
 * Where a REUSED goal was set up to run, versus where this launch will run it.
 *
 * A persona is pure identity and carries no target. Its journeys do, and a
 * launch may override that for one run without rewriting the shared
 * definition. The override is deliberate — it is what lets "run these six
 * goals against a new setup" avoid mutating six rows that other swarms also
 * launch — and it is also invisible, which is the problem this module exists
 * to fix. Nothing here changes what launches.
 *
 * ## Why a PLACE and not an environment id
 *
 * Most projects do not have the `project-environments-enabled` flag, so the
 * composer runs in compose mode and the launch target is an ad-hoc environment
 * row minted from the chosen clients and server group. Those ids are computed
 * server-side at resolve time, so comparing them tells a user nothing they
 * could have predicted, and comparing them is impossible for a legacy journey
 * that has no environment ids at all.
 *
 * What a user CAN reason about, and what actually decides whether a goal's
 * tools exist at the far end, is the pair (client, server group). Both modes
 * reduce to it:
 *
 *  - an env-based journey, through the rows its `environmentIds` resolve to;
 *  - a legacy journey, straight off its own `hostIds` + `serverAttachmentId`,
 *    which `listJourneysByPersona` already returns;
 *  - the destination, through the rows the launch resolved for this run.
 *
 * So a move is reported when the place changes, in either mode, and for both
 * kinds of journey.
 */

/** A project environment, reduced to what a move notice needs. */
export type EnvironmentMoveRow = {
  environmentId: string;
  /** Display label, already disambiguated — see `environmentLabelsById`. */
  label: string;
  /** The one client this row runs on. */
  hostId: string;
  /** `null` when the row runs the client's own servers rather than a group. */
  serverAttachmentId: string | null;
};

/**
 * Where one reused goal is set up to run today.
 *
 * `environmentIds` is the env-based fan-out; `null` marks a LEGACY journey,
 * whose place comes from `hostIds` and `serverAttachmentId` instead. Those two
 * fields are inactive compatibility data on an env-based row, so they are read
 * only on the legacy branch.
 */
export type ReusedGoalOrigin = {
  environmentIds?: readonly string[] | null;
  hostIds?: readonly string[];
  serverAttachmentId?: string | null;
};

/** One reused persona's goals that this launch would run somewhere else. */
export type ReusedEnvironmentMove = {
  /** How many of the persona's goals move. Never zero — `null` says none do. */
  goalCount: number;
  /**
   * Names for where those goals are set up to run. EMPTY when none of them
   * resolves to something the caller can name, which is a real state the copy
   * must handle rather than a reason to suppress the notice: the move still
   * happens.
   */
  fromLabels: string[];
  /**
   * The moved goals share no CLIENT with the destination. The usual shape of
   * this on a project without the environments flag, where the composer seeds
   * the first client and a returning user's goals were written against another.
   */
  differentClient: boolean;
  /**
   * The moved goals share no SERVER GROUP with the destination. The case worth
   * a caution: the goals' tools are not merely somewhere else, they are absent.
   */
  differentServerGroup: boolean;
};

/**
 * Whether a journey's stored fan-out already IS the selection.
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

/** `client|group` for one place, so two places compare as strings. */
function placeKey(hostId: string, serverAttachmentId: string | null): string {
  return `${hostId}|${serverAttachmentId ?? ""}`;
}

/** Places a goal is set up to run, or `null` when none can be determined. */
function originPlaces(
  origin: ReusedGoalOrigin,
  rowsById: ReadonlyMap<string, EnvironmentMoveRow>,
  hostName: (hostId: string) => string | undefined,
): EnvironmentMoveRow[] | null {
  const storedIds = origin.environmentIds;
  if (storedIds && storedIds.length > 0) {
    const rows = storedIds
      .map((environmentId) => rowsById.get(environmentId))
      .filter((row): row is EnvironmentMoveRow => row !== undefined);
    // An env-based journey whose rows the caller cannot see still HAS a place;
    // we simply cannot name it. Returning [] rather than null keeps the move
    // reportable while suppressing every claim about it.
    return rows;
  }
  // Legacy. `hostIds` is the live host pool it runs against, and
  // `serverAttachmentId` overrides the server list for all of them.
  const hostIds = origin.hostIds ?? [];
  if (hostIds.length === 0) return null;
  const serverAttachmentId = origin.serverAttachmentId ?? null;
  return hostIds.map((hostId) => ({
    environmentId: `host:${hostId}`,
    // A legacy journey has no environment to name, but it does have a client,
    // and the client is the half of the place a user recognizes.
    label: hostName(hostId) ?? "",
    hostId,
    serverAttachmentId,
  }));
}

/** True when both sides are known and share nothing. */
function disjoint(
  from: ReadonlySet<string>,
  to: ReadonlySet<string>,
): boolean {
  if (from.size === 0 || to.size === 0) return false;
  for (const value of from) if (to.has(value)) return false;
  return true;
}

/**
 * Describe the move one reused persona's goals are about to make, or `null`
 * when none of them moves.
 *
 * `selection` is the environment ids this launch resolved. An EMPTY selection
 * means no override is sent and every reused goal runs on whatever it already
 * carries, so nothing moves and nothing is claimed.
 */
export function describeReusedEnvironmentMove(args: {
  goals: readonly ReusedGoalOrigin[];
  selection: readonly string[];
  rowsById: ReadonlyMap<string, EnvironmentMoveRow>;
  /** Names a legacy journey's clients. Omit and they go unnamed, not unreported. */
  hostName?: (hostId: string) => string | undefined;
}): ReusedEnvironmentMove | null {
  const { goals, selection, rowsById } = args;
  const hostName = args.hostName ?? (() => undefined);
  if (selection.length === 0) return null;

  const toRows = selection
    .map((environmentId) => rowsById.get(environmentId))
    .filter((row): row is EnvironmentMoveRow => row !== undefined);
  const toPlaces = new Set(
    toRows.map((row) => placeKey(row.hostId, row.serverAttachmentId)),
  );

  const fromRows: EnvironmentMoveRow[] = [];
  const seenFrom = new Set<string>();
  let goalCount = 0;

  for (const goal of goals) {
    const places = originPlaces(goal, rowsById, hostName);
    // Nothing recorded about where this goal runs. The launch still overrides
    // it, but naming that a move would invent a history the row never had.
    if (places === null) continue;

    const storedIds = goal.environmentIds;
    const isEnvBased = Boolean(storedIds && storedIds.length > 0);
    const moved = isEnvBased
      ? // Ids are the honest comparison when the journey HAS ids: two rows can
        // share a client and a server group and still differ by model.
        !sameEnvironmentSelection(storedIds ?? null, selection)
      : // Legacy has no ids to compare, so the place is the only question. It
        // is also the only question worth asking: the override is unavoidable
        // for a legacy row, and saying so every time would be noise.
        places.some(
          (place) =>
            !toPlaces.has(placeKey(place.hostId, place.serverAttachmentId)),
        );
    if (!moved) continue;

    goalCount += 1;
    for (const place of places) {
      if (seenFrom.has(place.environmentId)) continue;
      seenFrom.add(place.environmentId);
      fromRows.push(place);
    }
  }

  if (goalCount === 0) return null;

  const known = (values: (string | null)[]) =>
    new Set(values.filter((value): value is string => Boolean(value)));

  return {
    goalCount,
    fromLabels: fromRows.map((row) => row.label).filter(Boolean),
    differentClient: disjoint(
      known(fromRows.map((row) => row.hostId)),
      known(toRows.map((row) => row.hostId)),
    ),
    differentServerGroup: disjoint(
      known(fromRows.map((row) => row.serverAttachmentId)),
      known(toRows.map((row) => row.serverAttachmentId)),
    ),
  };
}
