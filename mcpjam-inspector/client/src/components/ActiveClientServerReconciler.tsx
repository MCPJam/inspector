import { useMemo } from "react";
import { useAutoConnectProjectServers } from "@/hooks/useAutoConnectProjectServers";
import { useProjectServers } from "@/hooks/useViews";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

interface ActiveHostServerReconcilerProps {
  projectId: string | null;
  isAuthenticated: boolean;
  activeHost?: HostConfigDtoV2;
  activeHostId: string | null;
}

/**
 * Mounted once at the App root so host-switch reconciliation (disconnect
 * excess + connect required) fires regardless of which tab the user is on.
 *
 * Previously only `PlaygroundTab` and `ServersTab` mounted
 * `useAutoConnectProjectServers`, so switching hosts from the Tools tab
 * (or Resources / Prompts / OAuth Debugger / etc.) was silently a no-op:
 * the host change updated `initialize.clientCapabilities` for *new*
 * connects, but already-connected servers stayed up with stale caps and
 * any servers the new host didn't claim stayed up unnecessarily.
 *
 * Module-level dedupe inside the hook means the per-tab mounts can stay
 * in place without firing twice — first mount wins for a given
 * `(projectId, hostScope, reconciliationKey)` tuple.
 *
 * Renders nothing.
 */
export function ActiveClientServerReconciler({
  projectId,
  isAuthenticated,
  activeHost,
  activeHostId,
}: ActiveHostServerReconcilerProps) {
  const { servers: projectServersList } = useProjectServers({
    projectId,
    isAuthenticated,
  });

  // While `projectServersList` is loading we resolve to an empty
  // `requiredServerNames`. That's safe under main's "disconnect-all then
  // reconnect required" strategy: the connect-required pass is keyed on
  // a non-null `candidateNamesKey`, so it stays quiet until the catalog
  // arrives and the candidate set materializes, at which point it fires
  // exactly once.
  const requiredServerNames = useMemo(() => {
    const requiredIds = activeHost?.serverIds ?? [];
    if (requiredIds.length === 0 || !projectServersList) return [];
    const byId = new Map(
      projectServersList.map((s) => [s._id, s.name] as const),
    );
    return requiredIds
      .map((id) => byId.get(id))
      .filter((name): name is string => !!name);
  }, [activeHost?.serverIds, projectServersList]);

  useAutoConnectProjectServers({
    projectId,
    // Scope key is the explicit host id when one is picked; otherwise the
    // host config's own id (so swapping the project default to a different
    // host still counts as a scope change).
    hostScopeKey: activeHostId ?? activeHost?.id ?? null,
    requiredServerNames,
  });

  return null;
}
