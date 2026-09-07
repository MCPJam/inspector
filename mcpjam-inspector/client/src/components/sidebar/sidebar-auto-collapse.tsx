import * as React from "react";

import { useSidebar } from "@/components/ui/sidebar";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";

/**
 * Tabs whose working surface is wide enough that the 16rem sidebar costs more
 * than it gives: transcript + inspector panes (Playground), run tables
 * (Evaluate), the request/response timeline (OAuth and XAA Debugger), and the
 * swarm grid. Entering one of these collapses the sidebar to its icon rail;
 * leaving for any other tab expands it again.
 *
 * The two debuggers are listed together deliberately: they render the same
 * timeline, so splitting them would collapse the rail on one and not the other
 * for no reason a user could see.
 */
const WIDE_SURFACE_TABS = new Set([
  "playground",
  "evals",
  "evaluate",
  "oauth-flow",
  "xaa-flow",
  "swarms",
]);

export function isWideSurfaceTab(activeTab: string | undefined): boolean {
  return activeTab !== undefined && WIDE_SURFACE_TABS.has(activeTab);
}

/**
 * Drives the sidebar's open state from the active tab and the Ask MCPJam
 * panel.
 *
 * Only the *crossing* between a wide-surface tab and a normal one applies a
 * state, so a manual toggle sticks: collapse the sidebar on Home and it stays
 * collapsed across every other normal tab; expand it on Playground and it stays
 * expanded while you move between Playground, Evaluate and Swarms. Navigating
 * back out of the wide surfaces — including via the icon rail, which stays
 * clickable while collapsed — restores it.
 *
 * Opening Ask MCPJam is its own crossing: the panel takes the right side, so
 * the rail collapses even if the current tab would have left it expanded.
 * Closing the panel restores the tab policy, but only if this effect was the
 * one that collapsed it — a sidebar the user had already minimized stays
 * minimized.
 *
 * Renders nothing; it exists to hold the effect at the SidebarProvider scope.
 */
export function SidebarAutoCollapse({
  activeTab,
}: {
  activeTab: string | undefined;
}) {
  const { open, setOpen, isMobile } = useSidebar();
  const agentPanelOpen = useAgentPanelStore((s) => s.isOpen);
  const isWide = isWideSurfaceTab(activeTab);
  // null until the first desktop pass, so the initial tab gets its state
  // applied even when the app deep-links straight into a wide surface.
  const lastAppliedWideRef = React.useRef<boolean | null>(null);
  const lastPanelOpenRef = React.useRef<boolean | null>(null);
  const collapsedByPanelRef = React.useRef(false);

  // Layout, not passive: a passive effect runs after paint, so deep-linking
  // into a wide surface painted the rail at its full 16rem and then animated
  // it shut through the primitive's 200ms width transition. Running before
  // paint means the first frame is already collapsed.
  React.useLayoutEffect(() => {
    // Mobile has no inline sidebar to reclaim width from — it is a sheet that
    // is already closed by default. The agent panel is a full-width sheet
    // there too, so neither crossing is worth applying.
    if (isMobile) {
      return;
    }

    if (agentPanelOpen && lastPanelOpenRef.current !== true) {
      lastPanelOpenRef.current = true;
      collapsedByPanelRef.current = open;
      lastAppliedWideRef.current = true;
      setOpen(false);
      return;
    }

    if (!agentPanelOpen && lastPanelOpenRef.current === true) {
      lastPanelOpenRef.current = false;
      if (collapsedByPanelRef.current) {
        collapsedByPanelRef.current = false;
        lastAppliedWideRef.current = isWide;
        setOpen(!isWide);
      }
      return;
    }

    lastPanelOpenRef.current = agentPanelOpen;

    // The panel owns the rail while it is open. Tab crossings wait until
    // it closes so they cannot expand the sidebar out from under the chat.
    if (agentPanelOpen) {
      return;
    }

    if (lastAppliedWideRef.current === isWide) {
      return;
    }
    lastAppliedWideRef.current = isWide;
    setOpen(!isWide);
  }, [agentPanelOpen, isWide, isMobile, open, setOpen]);

  return null;
}
