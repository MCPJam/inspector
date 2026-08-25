import type { HostStyleFamily } from "@/lib/client-styles";

/**
 * Token sets keyed on the user's host-style preference, for the active row of
 * the chat history rail.
 *
 * Both families use the general `accent` family because the rail is a PANEL
 * surface (`bg-background`, inside the inset panel) — not the app sidebar.
 * Claude mimics used to reach for `sidebar-accent` to feel like a continuation
 * of the sidebar tab, but the Production Redesign (BB-127) swapped what those
 * two sidebar tokens mean: `--sidebar` became the linen ground and
 * `--sidebar-accent` the pale hover value. On the panel that left the ACTIVE
 * row paler than this same rail's own `hover:bg-accent/50`, which reads as the
 * selection having been lost.
 *
 * The map stays even though the two entries agree today: which token a host
 * family highlights with is a real per-family decision, and collapsing it would
 * make the next divergence a refactor instead of an edit.
 */
export const CHAT_HISTORY_STRONG_BG_CLASS: Record<HostStyleFamily, string> = {
  chatgpt: "bg-accent text-accent-foreground",
  claude: "bg-accent text-accent-foreground",
};
