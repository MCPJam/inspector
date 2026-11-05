import { useMemo } from "react";
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
) {
  const modelScope = useMemo(
    () =>
      scope
        ? {
            key: scope.pluginWorkspace.workspaceId,
            projectId: scope.projectId,
            hostId: scope.hostId,
            workspaceId: scope.pluginWorkspace.workspaceId,
          }
        : null,
    [scope],
  );
  const workspace = useOwnedModelAppWorkspace(
    rejectAppMessage,
    modelScope,
    capabilities?.modelContext !== false,
    capabilities?.displayModes === true,
    profile,
  );
  const value = useMemo(
    () => ({ ...workspace.value, messagesEnabled: false, canInvoke }),
    [workspace.value, canInvoke],
  );
  return { ...workspace, value };
}
