import { useMemo } from "react";
import type { DisplayBehavior } from "@mcpjam/sdk/widget-runtime";
import type { ExtensionLaunchProfile } from "@/lib/extension-launch-health";
import type { ExtensionCapabilities } from "./extension-owners";
import type { ThreadAppScope } from "./thread-app-api";
import { useOwnedModelAppWorkspace } from "./OwnedModelApp";

const rejectAppMessage = async () => false;

/** A lane owns model context, but Compare does not accept App-initiated turns. */
export function useCompareLaneModelApps(
  scope: ThreadAppScope | null,
  capabilities?: ExtensionCapabilities,
  profile?: ExtensionLaunchProfile,
  canInvoke?: () => boolean,
  displayBehavior?: DisplayBehavior,
) {
  const workspaceId = scope?.pluginWorkspace.workspaceId;
  const projectId = scope?.projectId;
  const hostId = scope?.hostId;
  const modelScope = useMemo(
    () => workspaceId !== undefined && projectId !== undefined && hostId !== undefined
      ? { key: workspaceId, projectId, hostId, workspaceId } : null,
    [workspaceId, projectId, hostId],
  );
  const workspace = useOwnedModelAppWorkspace(
    rejectAppMessage,
    modelScope,
    capabilities?.modelContext !== false,
    displayBehavior,
    profile,
  );
  const value = useMemo(
    () => ({ ...workspace.value, messagesEnabled: false, canInvoke }),
    [workspace.value, canInvoke],
  );
  return { ...workspace, value };
}
