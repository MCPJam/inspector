/**
 * Generic session filter dimensions — surface-agnostic.
 *
 * The chatbox usage panel has its own rich, `SharedChatThread`-coupled filter
 * model (`hooks/chatbox-usage-filters.ts`). The Swarms surface needs a much
 * smaller, generic host/persona filter over synthetic session rows, so rather
 * than grow the chatbox-named module with swarm concerns this holds the generic
 * primitive: an AND-of-dimensions predicate over any row exposing `hostId` /
 * `personaId`. Other surfaces can widen `SessionFilterDimension` as needed.
 */

export type SessionFilterDimension = "hostId" | "personaId";

export interface SessionFilterState {
  /** Active value per dimension; absent/null ⇒ that dimension is unfiltered. */
  hostId?: string | null;
  personaId?: string | null;
}

export const EMPTY_SESSION_FILTER: SessionFilterState = {};

/** A row is any object that may carry the filterable dimensions. */
export type FilterableSessionRow = Partial<
  Record<SessionFilterDimension, string | undefined>
>;

/**
 * True when `row` matches every ACTIVE dimension (dimensions are AND'd; an
 * absent/null filter value matches everything for that dimension).
 */
export function sessionMatchesFilter(
  row: FilterableSessionRow,
  filter: SessionFilterState,
): boolean {
  if (filter.hostId != null && row.hostId !== filter.hostId) return false;
  if (filter.personaId != null && row.personaId !== filter.personaId) {
    return false;
  }
  return true;
}

/** Toggle a dimension value: selecting the active value again clears it. */
export function toggleSessionFilter(
  filter: SessionFilterState,
  dimension: SessionFilterDimension,
  value: string,
): SessionFilterState {
  const current = filter[dimension];
  return {
    ...filter,
    [dimension]: current === value ? null : value,
  };
}
