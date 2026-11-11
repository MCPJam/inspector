import { useLayoutEffect, useRef, type ReactNode } from "react";
import { OwnedPluginFormHost } from "@/components/elicitation/OwnedPluginFormHost";
import { registerComposerSlot } from "@/components/elicitation/composer-form-store";
import { HostWorkspace } from "./HostWorkspace";
import { WorkspaceFileActionsProvider } from "./file-actions";
import type { ThreadAppWorkspace } from "./ThreadAppPanel";

/**
 * One compare lane's extension presentation: its own owner's Apps beside the
 * lane's conversation (a narrow lane is taken over, with "Back to chat"),
 * its file links, and its pending forms. Without an owner the lane renders
 * exactly as before.
 *
 * The lane stays mounted (hidden) while its Trace or Raw view is shown, so
 * its Apps never reload.
 */
export function CompareLaneWorkspace({
  apps,
  children,
  diagnostics,
  showDiagnostics,
  active = true,
}: {
  apps: Pick<ThreadAppWorkspace, "scope" | "fileActions" | "panel" | "open"> | null;
  children: ReactNode;
  diagnostics: ReactNode;
  showDiagnostics: boolean;
  active?: boolean;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const workspaceId = apps?.scope?.pluginWorkspace.workspaceId;
  useLayoutEffect(() => {
    if (workspaceId && slot.current)
      return registerComposerSlot(workspaceId, slot.current);
  }, [workspaceId]);
  if (!apps?.scope) return <>{showDiagnostics ? diagnostics : children}</>;
  return (
    <>
      {showDiagnostics ? diagnostics : null}
      <div
        data-compare-lane-workspace
        className="flex min-h-0 flex-1 flex-col"
        style={!active || showDiagnostics ? { display: "none" } : undefined}
      >
        <WorkspaceFileActionsProvider value={apps.fileActions}>
          <HostWorkspace appPanel={apps.panel} appOpen={apps.open}>
            {children}
            <OwnedPluginFormHost
              projectId={apps.scope.projectId}
              workspaceId={apps.scope.pluginWorkspace.workspaceId}
              active={active && !showDiagnostics}
            />
          </HostWorkspace>
          <div ref={slot} className="shrink-0" data-compare-lane-form-slot />
        </WorkspaceFileActionsProvider>
      </div>
    </>
  );
}
