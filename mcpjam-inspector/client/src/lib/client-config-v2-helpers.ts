/**
 * Pure helpers for HostConfigInputV2 that don't touch any zustand stores.
 *
 * `lib/playground/apply-host-defaults.ts` exposes `applyHostConfigToPlayground`
 * / `applyHostDefaultsToPlayground` which fan out side effects across
 * `useHostContextStore`, `useUIPlaygroundStore`, and a `preferencesStore`
 * setter bag. Useful in the playground; **wrong** anywhere else, because
 * those stores are shared with the playground surface — calling them from
 * the eval test case editor would leak the editor's tweaks into the
 * playground (and vice versa).
 *
 * This module exposes the same identity-snapshot logic as a pure function:
 * given a host-style id and a current HostConfigInputV2, return the next
 * HostConfigInputV2. Callers thread the result through their own state.
 */

import {
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import {
  seedFromHostTemplate,
  type HostTemplateId,
} from "@/lib/client-templates";

/**
 * Snapshot a host-style's template defaults onto a HostConfigInputV2 in-place
 * (well, immutably — returns a new value). Mirrors what
 * `applyHostConfigToPlayground` writes to the playground stores, but as data:
 *
 *   - `hostStyle`            = the picked id (BYO ids stay as themselves)
 *   - `hostContext`          = the host template's full hostContext blob
 *   - `mcpProfile`           = the host template's mcpProfile (may be undefined)
 *   - `hostCapabilitiesOverride` = the host template's override (may be undefined)
 *   - `chatUiOverride`       = the host template's chat-ui override (may be undefined)
 *   - everything else        = preserved from `current`
 *
 * The `modelId` is NOT touched. In the playground, the brand-pill click
 * also pokes the persisted model selection — that's a separate concern and
 * not part of the per-eval-case tweak surface (the eval editor has its own
 * `ModelSelector` in the editor body).
 */
export function applyHostStyleToHostConfigInput(
  hostStyle: string,
  current: HostConfigInputV2,
): HostConfigInputV2 {
  // `seedFromHostTemplate` is typed as `HostTemplateId` but the runtime
  // falls back to MCPJam on unknown ids; the cast keeps the call site
  // tolerant of BYO host-style ids registered client-side without a
  // matching template entry.
  const seed = seedFromHostTemplate(hostStyle as HostTemplateId);
  return {
    ...current,
    hostStyle,
    hostContext: seed.hostContext,
    mcpProfile: seed.mcpProfile,
    hostCapabilitiesOverride: seed.hostCapabilitiesOverride,
    chatUiOverride: seed.chatUiOverride,
  };
}
