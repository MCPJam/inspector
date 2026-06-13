/**
 * Glue between the side-panel store and the rest of the app:
 * - wires the global ⌘\ / Ctrl+\ shortcut to toggle the panel (skipping
 *   inputs/textareas/contentEditable to stay friendly to the composer);
 * - renders the panel itself.
 *
 * Lives at the SidebarProvider scope (above `<Outlet>`) so the panel survives
 * navigation between tabs without unmounting the in-flight `useChat`
 * instance.
 */
import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { AgentSidePanel } from "@/components/mcpjam-agent/AgentSidePanel";
import { useAppReady } from "@/hooks/use-app-ready";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";

interface AgentSidePanelMountProps {
  projectId: string | null;
  organizationId: string | null;
  activeTab: string;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function AgentSidePanelMount({
  projectId,
  organizationId,
  activeTab,
}: AgentSidePanelMountProps) {
  const toggle = useAgentPanelStore((s) => s.toggle);
  const posthog = usePostHog();

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "\\") return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      const willOpen = !useAgentPanelStore.getState().isOpen;
      if (willOpen) {
        posthog?.capture("mcpjam_agent_panel_opened", {
          via: "shortcut",
          tab: activeTab,
        });
      }
      toggle();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, posthog, toggle]);

  // Drop the persisted session pointer whenever the panel state and the
  // current active project disagree about which project the session belongs
  // to. The render path (`AgentSidePanel`) already gates the thread on a
  // project match, so a stale pointer is inert; this effect just GCs it so
  // it doesn't linger in localStorage. Wait for `useAppReady` so the normal
  // bootstrap step where `activeProjectId` flips from a synthetic
  // local-fallback id to the real Convex-scoped id isn't treated as a
  // project switch.
  const appReady = useAppReady();
  const activeSessionId = useAgentPanelStore((s) => s.activeSessionId);
  const activeSessionProjectId = useAgentPanelStore(
    (s) => s.activeSessionProjectId
  );
  useEffect(() => {
    if (appReady.status !== "ready") return;
    if (activeSessionId === null) return;
    if (activeSessionProjectId === projectId) return;
    useAgentPanelStore.getState().setActiveSession(null, null);
  }, [activeSessionId, activeSessionProjectId, appReady.status, projectId]);

  return (
    <AgentSidePanel
      projectId={projectId}
      organizationId={organizationId}
      activeTab={activeTab}
    />
  );
}
