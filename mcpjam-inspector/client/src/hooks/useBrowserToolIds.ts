import { useConvexAuth, useQuery } from "convex/react";
import { shouldQueryProjectId } from "./useProjects";
import { useMemo } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { resolveLocalBrowserTools } from "@/shared/local-browser-settings";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import { useAuth } from "@workos-inc/authkit-react";
import { useLocalBrowserConsent } from "./useLocalBrowserConsent";

export function useBrowserToolIds(
  config: HostConfigDtoV2 | null | undefined,
  engine: "local" | "cloud",
  scope?: { projectId: string | null; hostId?: string | null },
) {
  const { user } = useAuth();
  const consent = useLocalBrowserConsent();
  const { isAuthenticated } = useConvexAuth();
  // This preference exists even when the project has no default host config.
  // Include the named host so its explicit opt-out wins while its DTO loads.
  const querySettings =
    !HOSTED_MODE &&
    engine === "local" &&
    isAuthenticated &&
    !!user &&
    shouldQueryProjectId(scope?.projectId);
  const settings = useQuery(
    "hosts:getLocalBrowserSettings" as never,
    querySettings
      ? ({
          projectId: scope!.projectId,
          ...(scope?.hostId ? { hostId: scope.hostId } : {}),
        } as never)
      : "skip",
  ) as { enabled: boolean | null } | undefined;
  // Guest clients have no shared project setting to update. Their explicit
  // device grant supplies the local default, including views in other tabs.
  const enabled =
    (querySettings ? settings?.enabled : config?.localBrowserEnabled) ??
    (!user && consent.granted ? true : undefined);
  return useMemo(
    () =>
      resolveLocalBrowserTools(
        querySettings && !settings ? undefined : config?.builtInToolIds,
        enabled,
        !HOSTED_MODE && engine === "local",
      ),
    [config?.builtInToolIds, enabled, engine, querySettings, settings],
  );
}
