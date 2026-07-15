/**
 * Pure helpers for HostConfigInputV2 that don't touch any zustand stores.
 *
 * `lib/playground/apply-client-defaults.ts` exposes
 * `applyHostConfigToPlayground`, which fans out side effects across
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

import { type HostConfigInputV2 } from "@/lib/client-config-v2";
import {
  bundledHostCompatCatalog,
  getCatalogTemplate,
} from "@mcpjam/sdk/host-compat";

/**
 * Snapshot a host-style's catalog defaults onto a HostConfigInputV2 in-place
 * (well, immutably — returns a new value). Mirrors what
 * `applyHostConfigToPlayground` writes to the playground stores, but as data:
 *
 *   - `hostStyle`            = the picked id (BYO ids stay as themselves)
 *   - `hostContext`          = the catalog host's full hostContext blob
 *   - `mcpProfile`           = the catalog host's mcpProfile (may be undefined)
 *   - `hostCapabilitiesOverride` = the catalog host's override (may be undefined)
 *   - `chatUiOverride`       = the catalog host's chat-ui override (may be undefined)
 *   - everything else        = preserved from `current`
 *
 * The `modelId` is NOT touched. The playground host-sync path also pokes
 * the persisted model selection — that's a separate concern and not part
 * of the per-eval-case tweak surface (the eval editor has its own
 * `ModelSelector` in the editor body).
 */
export function applyHostStyleToHostConfigInput(
  hostStyle: string,
  current: HostConfigInputV2
): HostConfigInputV2 {
  const seed = getCatalogTemplate(
    bundledHostCompatCatalog(),
    hostStyle
  ) as HostConfigInputV2 | undefined;
  return {
    ...current,
    hostStyle,
    hostContext: seed ? seed.hostContext : current.hostContext,
    mcpProfile: seed ? seed.mcpProfile : current.mcpProfile,
    hostCapabilitiesOverride: seed
      ? seed.hostCapabilitiesOverride
      : current.hostCapabilitiesOverride,
    chatUiOverride: seed ? seed.chatUiOverride : current.chatUiOverride,
  };
}
