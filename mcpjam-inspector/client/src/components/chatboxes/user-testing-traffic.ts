import {
  chipKey,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";

/**
 * User Testing's traffic policy: what counts as a tester session on this
 * surface.
 *
 * Scenarios carry real-user traffic only, but historical synthetic rows from
 * the retired chatbox session-simulation flow are still in the database. This
 * chip is force-applied on every User Testing read so they stay hidden.
 *
 * It lives beside the surface rather than inside the insights components
 * because it is a statement about this product's population, not about how
 * insights are drawn — the same policy applies to the sessions list, which has
 * no insights in it at all.
 */
export const HIDE_SYNTHETIC_CHIP: UsageFilterChip = {
  kind: "dimension",
  key: "synthetic",
  value: "hide",
  label: "Hide synthetic",
};

export function withHideSynthetic(filter: UsageFilterState): UsageFilterState {
  if (filter.chips.some((c) => chipKey(c) === chipKey(HIDE_SYNTHETIC_CHIP))) {
    return filter;
  }
  return { ...filter, chips: [...filter.chips, HIDE_SYNTHETIC_CHIP] };
}
