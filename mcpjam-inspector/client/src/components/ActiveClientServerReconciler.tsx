import { useEffect, useMemo } from "react";
import { useAutoConnectProjectServers } from "@/hooks/useAutoConnectProjectServers";
import { useProjectServers } from "@/hooks/useViews";
import { useSharedAppState } from "@/state/app-state-context";
import { useServerActions } from "@/state/server-actions-context";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

/** Set-equality for two name lists, order-independent. */
function sameNameSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const name of b) {
    if (!set.has(name)) return false;
  }
  return true;
}

function isActiveRuntimeStatus(status: string | undefined) {
  return status === "connected" || status === "connecting";
}

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
      projectServersList.map((s) => [s._id, s.name] as const)
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

  // Single source of truth: the Playground active server set
  // (`selectedMultipleServers`) mirrors the runtime set that is connected or
  // reconnecting. Keeping "connecting" active prevents the Playground tools
  // pane from blinking empty during a client-switch reconnect. The Connect tab
  // owns connectivity; everything else reflects it. Guarded by set-equality so
  // we never dispatch (and never loop) when the mirror already matches.
  const sharedAppState = useSharedAppState();
  const { setSelectedServerNames } = useServerActions();
  const activeRuntimeNames = useMemo(
    () =>
      Object.entries(sharedAppState.servers)
        .filter(([, server]) => isActiveRuntimeStatus(server.connectionStatus))
        .map(([name]) => name),
    [sharedAppState.servers]
  );
  useEffect(() => {
    if (
      !sameNameSet(activeRuntimeNames, sharedAppState.selectedMultipleServers)
    ) {
      setSelectedServerNames(activeRuntimeNames);
    }
  }, [
    activeRuntimeNames,
    sharedAppState.selectedMultipleServers,
    setSelectedServerNames,
  ]);

  return null;
}
