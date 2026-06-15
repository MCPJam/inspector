import { useMemo } from "react";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { useBuiltInToolCatalog } from "@/hooks/useBuiltInToolCatalog";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { visibleBuiltInToolCatalog } from "@/lib/host-config-computer";
import type { HostFocusTabId } from "../types";

export interface HostFocusTabDef {
  id: HostFocusTabId;
  label: string;
}

export const HOST_FOCUS_TAB_DEFS: ReadonlyArray<HostFocusTabDef> = [
  { id: "behavior", label: "Agent" },
  { id: "protocol", label: "MCP Protocol" },
  { id: "apps", label: "Apps" },
  // Tools is GA (built-in tools like Web Search). Computer is flag-gated —
  // see `visibleHostFocusTabs`. Both sit at the right end of the tab bar.
  { id: "tools", label: "Tools" },
  { id: "computer", label: "Computer" },
  // Servers moved to Project Settings → Servers (one server set across
  // every host in the project). Removed from the per-host tab list as
  // part of the project-scoped server config rollout. The "servers"
  // HostFocusTabId variant is kept for state-compat with persisted UI
  // state that may still reference it; the type-level enum stays so
  // legacy URLs / sessionStorage don't crash.
  // { id: "appearance", label: "Appearance" }, // hidden — to reintroduce soon
];

/**
 * Filter the static tab defs to those that should render for this host:
 *   - **Tools** appears only when the deployment exposes at least one
 *     built-in tool the user may see (no dead, empty tab on bare installs).
 *   - **Computer** is gated behind `computers-enabled`, OR shown when a
 *     computer is already attached so an existing attachment stays
 *     detachable even with the flag off (mirrors `shouldShowComputerToggle`).
 */
export function visibleHostFocusTabs(opts: {
  hasBuiltInTools: boolean;
  computersEnabled: boolean;
  computerAttached: boolean;
}): HostFocusTabDef[] {
  return HOST_FOCUS_TAB_DEFS.filter((t) => {
    if (t.id === "tools") return opts.hasBuiltInTools;
    if (t.id === "computer")
      return opts.computersEnabled || opts.computerAttached;
    return true;
  });
}

/**
 * Clamp the requested tab to one that is actually visible. A tab can be hidden
 * out from under the user — e.g. detaching the computer with the flag off while
 * the Computer tab is open, or the catalog emptying while on Tools. Without
 * clamping, the stored `tab` would keep rendering the now-hidden tab's content
 * (letting the user re-attach from a tab the bar no longer shows) and desync
 * the tab-bar highlight. Falls back to the first visible tab (always present;
 * the static Agent/Protocol/Apps tabs are never filtered).
 */
export function activeHostFocusTab(
  tab: HostFocusTabId,
  visibleTabs: ReadonlyArray<HostFocusTabDef>,
): HostFocusTabId {
  if (visibleTabs.some((t) => t.id === tab)) return tab;
  return visibleTabs[0]?.id ?? "behavior";
}

/**
 * Hook wrapper around `visibleHostFocusTabs` for the focus surfaces
 * (HostFocusPanel / HostFocusDialog) so the Tools/Computer gating lives in
 * one place. Subscribes to the same catalog + flag the Tools/Computer tab
 * bodies use (cheap, shared Convex subscriptions).
 */
export function useVisibleHostFocusTabs(
  draft: HostConfigInputV2,
): HostFocusTabDef[] {
  const catalog = useBuiltInToolCatalog();
  const computersEnabled = useComputersEnabled();
  const visible = visibleBuiltInToolCatalog(catalog, {
    computersEnabled,
    selectedIds: draft.builtInToolIds,
  });
  const hasBuiltInTools = (visible?.length ?? 0) > 0;
  const computerAttached = draft.computer !== undefined;
  return useMemo(
    () =>
      visibleHostFocusTabs({
        hasBuiltInTools,
        computersEnabled,
        computerAttached,
      }),
    [hasBuiltInTools, computersEnabled, computerAttached],
  );
}
