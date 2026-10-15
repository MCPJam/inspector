import type { ReactNode } from "react";
import { OwnedPluginFormHost } from "@/components/elicitation/OwnedPluginFormHost";
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
}: {
  apps: ThreadAppWorkspace | null;
  children: ReactNode;
  diagnostics: ReactNode;
  showDiagnostics: boolean;
}) {
  if (!apps?.scope) return <>{showDiagnostics ? diagnostics : children}</>;
  return (
    <>
      {showDiagnostics ? diagnostics : null}
      <div
        data-compare-lane-workspace
        className="flex min-h-0 flex-1 flex-col"
        style={showDiagnostics ? { display: "none" } : undefined}
      >
        <WorkspaceFileActionsProvider value={apps.fileActions}>
          <HostWorkspace appPanel={apps.panel} appOpen={apps.open}>
            {children}
            <OwnedPluginFormHost
              projectId={apps.scope.projectId}
              workspaceId={apps.scope.pluginWorkspace.workspaceId}
            />
          </HostWorkspace>
        </WorkspaceFileActionsProvider>
      </div>
    </>
  );
}
