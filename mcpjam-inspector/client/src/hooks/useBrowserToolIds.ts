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
  // THE DEVICE GRANT ANSWERS WHEN NOTHING SHARED CAN — the same rule for
  // every actor, rather than one rule for guests and another for members.
  //
  // A shared setting, where one is readable, stays authoritative in both
  // directions: an explicit opt-out still wins, and a project that never
  // enabled Browser still means no Browser (`enableLocalBrowserForManagedProjects`
  // SKIPS projects the member cannot manage, so "nothing stored" there is an
  // org decision they are not allowed to overrule from their own machine).
  //
  // `!querySettings` is what "nothing shared can answer" means: a guest, whose
  // Allow is device-scoped and writes no project default, and a member on a
  // local-only project, who has no Convex project to store one in. Both
  // authorized this machine explicitly; both used to get a silent
  // no-Browser turn out of a setting that does not exist for them.
  const enabled =
    (querySettings ? settings?.enabled : config?.localBrowserEnabled) ??
    (!querySettings && consent.granted ? true : undefined);
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
