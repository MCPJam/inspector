/**
 * `HostSnapshot` — the subset of `HostConfigDtoV2` the per-card
 * `MultiModelPlaygroundCard` needs when running in multi-host mode.
 *
 * The card has two callers:
 *   - Multi-MODEL caller (`PlaygroundMain` multi-model branch): doesn't
 *     pass `hostSnapshot`. The card falls back to the tab-root provider
 *     values via `useContext` — behavior-identical to single-host today.
 *   - Multi-HOST caller (`PlaygroundMain` multi-host branch, Phase 4):
 *     passes one `hostSnapshot` per column. The card's inner providers
 *     shadow the tab-root context for that subtree so per-column host
 *     UX surface (style, capabilities, chat UI, MCP profile) flows into
 *     chat + trace + raw views.
 *
 * Shape mirrors `HostConfigDtoV2` from `client-config-v2.ts` (which mirrors
 * the backend `HostConfig` in `mcpjam-backend/convex/lib/hostConfigV2.ts`).
 * Keep the field set minimal: only what the card actually shadows. Adding
 * a field here means the card consumes it; removing means the card no
 * longer can.
 *
 * Phase 3 had five separate optional card props with `*Set` discriminator
 * booleans (`hostCapabilitiesOverride` + `hostCapabilitiesOverrideSet`,
 * `chatUiOverride` + `chatUiOverrideSet`, `mcpProfile` + `mcpProfileSet`,
 * `activeHost`). This consolidates them into one prop so a reviewer reading
 * the call site sees one `hostSnapshot={...}` instead of five overlapping
 * fields. The `activeHost`-derived `hostCapsResolver` stays separate — it's
 * a function/object resolver, not a serializable config field, and lives on
 * a different abstraction layer than the persisted snapshot.
 */
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

export type HostSnapshot = Pick<
  HostConfigDtoV2,
  "hostStyle" | "hostCapabilitiesOverride" | "chatUiOverride" | "mcpProfile"
>;

/**
 * Extract the playground card's host-snapshot from a full host config DTO.
 * Centralizes the projection so multi-host callers don't reach into
 * arbitrary DTO fields. Returns a fresh object — no aliasing — but does
 * NOT deep-clone the inner records (the card treats them as read-only).
 */
export function snapshotFromHostConfig(
  config: HostConfigDtoV2,
): HostSnapshot {
  return {
    hostStyle: config.hostStyle,
    hostCapabilitiesOverride: config.hostCapabilitiesOverride,
    chatUiOverride: config.chatUiOverride,
    mcpProfile: config.mcpProfile,
  };
}
