/**
 * Glue between the side-panel store and the rest of the app:
 * - gates the panel + shortcut behind the `home-page-enabled` PostHog flag;
 * - wires the global ⌘\ / Ctrl+\ shortcut to toggle the panel (skipping
 *   inputs/textareas/contentEditable to stay friendly to the composer);
 * - renders the panel itself.
 *
 * Lives at the SidebarProvider scope (above `<Outlet>`) so the panel survives
 * navigation between tabs without unmounting the in-flight `useChat`
 * instance.
 */
import { useEffect, useRef } from "react";
import { useFeatureFlagEnabled, usePostHog } from "posthog-js/react";
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
  const homeEnabled = useFeatureFlagEnabled("home-page-enabled");
  const isOpen = useAgentPanelStore((s) => s.isOpen);
  const toggle = useAgentPanelStore((s) => s.toggle);
  const posthog = usePostHog();

  useEffect(() => {
    if (!homeEnabled) return undefined;
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
  }, [activeTab, homeEnabled, posthog, toggle]);

  // Even when the flag is off, an already-persisted `isOpen=true` should not
  // be honored — the entry point is hidden, so a stale stored value must not
  // leave the panel showing. Gate on the explicit `false` so the brief window
  // where `useFeatureFlagEnabled` returns `undefined` during PostHog hydration
  // doesn't silently close a panel the user reopened across reloads.
  useEffect(() => {
    if (homeEnabled === false && isOpen) {
      useAgentPanelStore.getState().setOpen(false);
    }
  }, [homeEnabled, isOpen]);

  // Switching projects must drop the active session pointer — sessions are
  // project-scoped on the backend, so reusing an id from a different project
  // would post under the wrong project or 404 on hydration. Two things this
  // guard has to avoid:
  //   1. The initial render (would clear the persisted sessionId on reload).
  //   2. The bootstrap window where `activeProjectId` flips from a synthetic
  //      local-fallback id to the real Convex-scoped id — that's normal
  //      hydration, not a user-initiated switch.
  // Gating on `useAppReady().status === "ready"` covers (2), and a seeded
  // ref covers (1) post-ready.
  const appReady = useAppReady();
  const lastProjectIdRef = useRef<string | null>(null);
  const projectIdSeededRef = useRef(false);
  useEffect(() => {
    if (appReady.status !== "ready") return;
    if (!projectIdSeededRef.current) {
      projectIdSeededRef.current = true;
      lastProjectIdRef.current = projectId;
      return;
    }
    if (lastProjectIdRef.current === projectId) return;
    lastProjectIdRef.current = projectId;
    useAgentPanelStore.getState().setActiveSessionId(null);
  }, [appReady.status, projectId]);

  if (!homeEnabled) return null;

  return (
    <AgentSidePanel
      projectId={projectId}
      organizationId={organizationId}
      activeTab={activeTab}
    />
  );
}
