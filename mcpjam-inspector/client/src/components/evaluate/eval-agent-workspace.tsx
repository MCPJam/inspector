import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useEvalChatHost } from "@/lib/mcpjam-agent/eval-chat-host";

/** Chat participates in the dashboard layout below its breadcrumb/header. */
export function EvalAgentWorkspace({
  projectId,
  organizationId,
  children,
}: {
  projectId: string | null;
  organizationId: string | null;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!host.current) return;
    const element = host.current;
    useEvalChatHost.getState().setHost({ element, projectId, organizationId });
    return () => {
      if (useEvalChatHost.getState().host?.element === element)
        useEvalChatHost.getState().setHost(null);
    };
  }, [projectId, organizationId]);
  return (
    <div
      data-testid="eval-agent-workspace"
      className="relative flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
      <div ref={host} className="contents" />
    </div>
  );
}
