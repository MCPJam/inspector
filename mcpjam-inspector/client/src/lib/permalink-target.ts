/**
 * Resolving an agent-minted permalink's resource against what the viewer can
 * actually see.
 *
 * A permalink names one exact resource: `/servers/<id>`,
 * `/environments/<id>`, `/servers/plugins/<id>`. Three things can be true when
 * the recipient opens it, and the screen has to tell them apart:
 *
 *   - the list has not loaded yet — render nothing, do NOT decide;
 *   - the resource is in the list — select it;
 *   - the list loaded and the resource is not in it — say so, once, and stop.
 *
 * The failure this exists to prevent is the third case QUIETLY becoming the
 * first: a screen that "just renders the collection" when the id misses shows
 * the recipient a different server, a different environment, a different
 * plugin, with no sign that the link they followed pointed somewhere else.
 * That is the exact class of bug permalinks were introduced to end, so it
 * must not reappear at the last step.
 *
 * `unavailable` deliberately does NOT distinguish deleted from
 * not-authorized. Both are answered with one message, because answering them
 * differently tells someone without access that the id exists — a membership
 * oracle over ids an agent hands around freely.
 */

export type PermalinkTargetState<T> =
  /** The collection has not arrived. Decide nothing yet. */
  | { kind: "loading" }
  /** No permalink target was requested; render the surface normally. */
  | { kind: "none" }
  | { kind: "found"; target: T }
  /** Loaded, and the id is not among the rows this viewer can see. */
  | { kind: "unavailable"; requestedId: string };

/**
 * Match one requested id against a loaded collection.
 *
 * `items === undefined` means "still loading" (the Convex reactive-query
 * convention this app uses everywhere); an empty ARRAY is a loaded, empty
 * collection and resolves to `unavailable`, not to `loading`. Conflating
 * those two is what would leave a permalink spinning forever on a project
 * with no servers.
 */
export function resolvePermalinkTarget<T>(
  requestedId: string | null | undefined,
  items: readonly T[] | undefined | null,
  identify: (item: T) => string | undefined,
): PermalinkTargetState<T> {
  const wanted = requestedId?.trim();
  if (!wanted) return { kind: "none" };
  if (items == null) return { kind: "loading" };
  const target = items.find((item) => identify(item) === wanted);
  return target ? { kind: "found", target } : { kind: "unavailable", requestedId: wanted };
}

/**
 * The one message for an unavailable target.
 *
 * One sentence covering deleted, moved, and never-visible on purpose: see the
 * module note. `resourceLabel` names the KIND ("server", "environment"),
 * never the id — echoing an id back confirms its shape to whoever pasted it.
 */
export function permalinkUnavailableMessage(resourceLabel: string): string {
  return `That ${resourceLabel} isn't available in this project. It may have been deleted, or you may not have access to it.`;
}
