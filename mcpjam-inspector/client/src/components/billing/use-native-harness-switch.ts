import { useState } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useHostList } from "@/hooks/useClients";
import { useCanManageProjectClients } from "@/hooks/useProjects";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";
import { effectiveHarnessId } from "@/shared/harness-descriptors";

/**
 * What the switch did. `skipped` are clients it left on their native
 * harness: held by another member's study, or keeping a computer whose own
 * feature is off. Older backends send no `skippedReasons`.
 */
interface SwitchResult {
  switched: number;
  skipped: number;
  skippedReasons?: {
    client_locked_by_study?: number;
    feature_unavailable?: number;
  };
}

const switchProjectRef = makeFunctionReference<
  "mutation",
  { projectId: string },
  SwitchResult
>("clientHarness:switchProjectClientsToMcpjamHarness");

function clientCount(count: number): string {
  return `${count} ${count === 1 ? "client" : "clients"}`;
}

/** The skipped clients, by reason when there is just one. */
function skippedClientsMessage({
  skipped,
  skippedReasons,
}: SwitchResult): string {
  if (skipped <= 0) return "";
  const their = skipped === 1 ? "its" : "their";
  const kept = `${clientCount(skipped)} kept ${their} native harness`;
  if (skippedReasons?.client_locked_by_study === skipped)
    return `${clientCount(skipped)} in another member's study kept ${their} native harness.`;
  if (skippedReasons?.feature_unavailable === skipped)
    return `${kept} because ${their} computer needs a feature your organization doesn't have.`;
  return `${kept}. Open ${skipped === 1 ? "the client" : "each client"} to see why.`;
}

/** What the switch changed, for its toast. */
export function switchedClientsMessage(result: SwitchResult): string {
  const kept = skippedClientsMessage(result);
  const { switched } = result;
  if (switched === 0) return kept || "No clients needed a change.";
  const moved = `${clientCount(switched)} now ${switched === 1 ? "runs" : "run"} on MCPJam Harness.`;
  return kept ? `${moved} ${kept}` : moved;
}

/**
 * The limit dialog's switch: every client in the project that runs a native
 * harness moves to MCPJam Harness. `switchCount` is how many that is for a
 * project admin, and zero for anyone else, who cannot change clients.
 * `projectId` is the Convex project, or null to offer no switch at all.
 * `switchClients` resolves true only when a client moved: with none moved,
 * the person is still out of turns and the dialog should stay.
 */
export function useNativeHarnessSwitch(projectId: string | null): {
  switchCount: number;
  isSwitching: boolean;
  switchClients: () => Promise<boolean>;
} {
  const { isAuthenticated } = useConvexAuth();
  const { hosts } = useHostList({ isAuthenticated, projectId });
  const { canManage } = useCanManageProjectClients({
    isAuthenticated,
    projectId,
  });
  const switchProject = useMutation(switchProjectRef);
  const [isSwitching, setIsSwitching] = useState(false);
  const nativeClients = hosts.filter(
    (host) => effectiveHarnessId(host) !== null,
  ).length;

  const switchClients = async () => {
    if (!projectId || isSwitching) return false;
    setIsSwitching(true);
    try {
      const result = await switchProject({ projectId });
      if (result.switched > 0) toast.success(switchedClientsMessage(result));
      else toast.info(switchedClientsMessage(result));
      return result.switched > 0;
    } catch (error) {
      toast.error(
        convexErrMessage(
          error,
          "Could not switch this project's clients to MCPJam Harness. Try again.",
        ),
      );
      return false;
    } finally {
      setIsSwitching(false);
    }
  };

  return {
    switchCount: projectId && canManage ? nativeClients : 0,
    isSwitching,
    switchClients,
  };
}
