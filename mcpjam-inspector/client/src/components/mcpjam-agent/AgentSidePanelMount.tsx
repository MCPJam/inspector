import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AgentSidePanel } from "./AgentSidePanel";
import { useDescribeSurface } from "@/lib/mcpjam-agent/describe-surface";
import { useEvalChatHost } from "@/lib/mcpjam-agent/eval-chat-host";
import { openEvalChat } from "@/lib/mcpjam-agent/eval-scope";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";

export function AgentSidePanelMount({
  activeTab,
}: {
  projectId: string | null;
  organizationId: string | null;
  activeTab: string;
}) {
  const scope = useDescribeSurface((s) => s.scope);
  const host = useEvalChatHost((s) => s.host);
  useEffect(() => {
    if (!scope || activeTab !== "evaluate") return;
    const handler = (event: KeyboardEvent) => {
      if (
        event.key !== "\\" ||
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey
      )
        return;
      if (
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))
      )
        return;
      event.preventDefault();
      const panel = useAgentPanelStore.getState();
      if (panel.isOpen) panel.setOpen(false);
      else openEvalChat(scope);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [scope, activeTab]);
  if (
    activeTab !== "evaluate" ||
    !scope ||
    !host ||
    host.projectId !== scope.projectId
  )
    return null;
  return createPortal(
    <AgentSidePanel
      projectId={scope.projectId}
      organizationId={host.organizationId}
      activeTab={activeTab}
    />,
    host.element,
  );
}
