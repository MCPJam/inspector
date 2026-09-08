import {
  openEvalChat,
  useEvalAgentScopes,
} from "@/lib/mcpjam-agent/eval-scope";
import { createPortal } from "react-dom";
import { useEvalChatHost } from "@/lib/mcpjam-agent/eval-chat-host";
import { currentEvalPageScope } from "@/lib/mcpjam-agent/eval-workspace";
/** Keep scoped eval chat in its dashboard and general chat available app-wide. */
import { useEffect } from "react";
import { AgentSidePanel } from "@/components/mcpjam-agent/AgentSidePanel";
import { useAppReady } from "@/hooks/use-app-ready";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { track } from "@/lib/analytics";

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
  const sessionId = useAgentPanelStore((s) => s.activeSessionId);
  const scoped = useEvalAgentScopes(
    (s) =>
      !!sessionId && (!!s.scopes[sessionId] || sessionId.startsWith("eval-")),
  );
  const isOpen = useAgentPanelStore((s) => s.isOpen);
  const toggle = useAgentPanelStore((s) => s.toggle);
  const host = useEvalChatHost((s) => s.host);
  const inEvaluate = activeTab === "evaluate";
  const resolvedProjectId = inEvaluate && host ? host.projectId : projectId;

  useEffect(() => {
    if (!inEvaluate && scoped && isOpen)
      useAgentPanelStore.getState().setOpen(false);
  }, [inEvaluate, scoped, isOpen]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "\\") return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const willOpen = !useAgentPanelStore.getState().isOpen;
      const context =
        willOpen && inEvaluate ? currentEvalPageScope() : undefined;

      event.preventDefault();
      if (willOpen) {
        track("mcpjam_agent_panel_opened", {
          location: "agent_side_panel",
          via: "shortcut",
          tab: activeTab,
        });
      }
      if (context) openEvalChat(context);
      else {
        if (willOpen && scoped)
          useAgentPanelStore.getState().setActiveSession(null, null);
        toggle();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, inEvaluate, scoped, toggle]);

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
    (s) => s.activeSessionProjectId,
  );
  useEffect(() => {
    if (appReady.status !== "ready") return;
    if (inEvaluate && !host) return;
    if (activeSessionId === null) return;
    if (activeSessionProjectId === resolvedProjectId) return;
    useAgentPanelStore.getState().setActiveSession(null, null);
  }, [
    activeSessionId,
    activeSessionProjectId,
    appReady.status,
    resolvedProjectId,
    inEvaluate,
    host,
  ]);

  if (!inEvaluate && scoped) return null;
  if (inEvaluate && scoped && !host) return null;
  const panel = (
    <AgentSidePanel
      projectId={resolvedProjectId}
      organizationId={inEvaluate && host ? host.organizationId : organizationId}
      activeTab={activeTab}
    />
  );
  return inEvaluate && host ? createPortal(panel, host.element) : panel;
}
