import { useMemo } from "react";
import { HOSTED_MODE } from "@/lib/config";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { useBuiltInToolCatalog } from "@/hooks/useBuiltInToolCatalog";
import {
  useComputersEnabled,
  useBrowserEnabled,
} from "@/hooks/useComputersEnabled";
import { visibleBuiltInToolCatalog } from "@/lib/host-config-computer";
import { effectiveHarnessId } from "@/shared/harness-descriptors";
import { useWebClientsEnabled } from "@/hooks/useWebClientsEnabled";
import { webClientVendorOfHost } from "@/lib/web-accounts/clients";
import type { FocusTabDef } from "@/components/canvas-kit/FocusTabBar";
import { useEventsEnabledState } from "@/hooks/useEventsEnabled";
import type { HostFocusTabId } from "../types";

export type HostFocusTabDef = FocusTabDef<HostFocusTabId>;

export const HOST_FOCUS_TAB_DEFS: ReadonlyArray<HostFocusTabDef> = [
  { id: "behavior", label: "Agent" },
  { id: "protocol", label: "MCP Protocol" },
  { id: "apps", label: "Apps" },
  // MCP Events delivery, behind the Events flag (see `visibleHostFocusTabs`).
  { id: "events", label: "Events" },
  // Tools is GA (built-in tools like Web Search). Computer is flag-gated —
  // see `visibleHostFocusTabs`. Both sit at the right end of the tab bar.
  { id: "tools", label: "Tools" },
  { id: "browser", label: "Browser" },
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
 *   - **Computer** is gated behind the machine flag, OR shown when a computer
 *     is already attached so an existing attachment stays detachable even with
 *     the flag off (mirrors `shouldShowComputerToggle`). Never shown for a
 *     client on a native harness (its `agentLoop` or `harness`): it runs on a
 *     throwaway box and has no computer settings, attached or not.
 *   - **Events** follows the MCP Events flag only. Templates and the backfill
 *     save a setting on nearly every client, so "or a saved setting" would
 *     show it to everyone.
 */
export function visibleHostFocusTabs(opts: {
  hasBuiltInTools: boolean;
  computersEnabled: boolean;
  computerAttached: boolean;
  /** The client runs a harness; it shows no Computer tab. */
  hasHarness?: boolean;
  browsersEnabled?: boolean;
  browserConfigured?: boolean;
  /** A web client keeps its accounts on the Browser tab. */
  webClient?: boolean;
  /** The MCP Events flag. */
  eventsEnabled?: boolean;
}): HostFocusTabDef[] {
  return HOST_FOCUS_TAB_DEFS.filter((t) => {
    if (t.id === "events") return opts.eventsEnabled === true;
    if (t.id === "browser")
      return (
        opts.webClient === true ||
        opts.browsersEnabled === true ||
        opts.browserConfigured === true
      );
    if (t.id === "tools") return opts.hasBuiltInTools;
    if (t.id === "computer")
      return (
        opts.hasHarness !== true &&
        (opts.computersEnabled || opts.computerAttached)
      );
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
  const browsersEnabled = useBrowserEnabled();
  const visible = visibleBuiltInToolCatalog(catalog, {
    computersEnabled,
    browsersEnabled,
    selectedIds: draft.builtInToolIds,
  });
  const hasBuiltInTools =
    visible?.some((tool) => tool.id !== "browser") ?? false;
  const browserConfigured =
    (!HOSTED_MODE && draft.localBrowserEnabled === true) || draft.builtInToolIds.includes("browser") || Boolean(draft.browserProfileId);
  const computerAttached = draft.computer !== undefined;
  const hasHarness = effectiveHarnessId(draft) !== null;
  const webClient =
    useWebClientsEnabled() && webClientVendorOfHost(draft) !== undefined;
  const eventsEnabled = useEventsEnabledState() === true;
  return useMemo(
    () =>
      visibleHostFocusTabs({
        hasBuiltInTools,
        computersEnabled,
        computerAttached,
        hasHarness,
        browsersEnabled,
        browserConfigured,
        webClient,
        eventsEnabled,
      }),
    [
      hasBuiltInTools,
      computersEnabled,
      computerAttached,
      hasHarness,
      browsersEnabled,
      browserConfigured,
      webClient,
      eventsEnabled,
    ],
  );
}
