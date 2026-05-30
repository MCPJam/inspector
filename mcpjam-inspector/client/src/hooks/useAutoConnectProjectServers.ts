import { useEffect, useMemo, useRef } from "react";
import type { EnsureServersReadyResult } from "@/hooks/use-server-state";
import { useSharedAppState } from "@/state/app-state-context";
import { useServerActions } from "@/state/server-actions-context";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/**
 * Module-level memo of "we already kicked off ensureServersReady for this
 * (project, host-scope, server-name)". Lives outside React state on
 * purpose: navigating Servers → Host → Playground re-mounts the hook
 * three times but should only fire one batch per scope. Cleared per-
 * project on entry so switching projects starts fresh.
 *
 * Granularity is per-server within a scope, not per-candidate-set. That
 * matters for two cases the old per-set keying got wrong: (a) the user
 * manually disconnects one of N required servers, which would otherwise
 * produce a fresh (N−1)-element candidate set and re-fire; (b) the
 * "refresh-keeps-failing" guard — once a server has been attempted in
 * this scope (success, failure, or stalled OAuth) we never auto-retry it.
 * Switching hosts counts as a different scope, so the user can recover
 * from a transient failure by switching hosts; otherwise the per-card
 * connect toggle in the Servers tab is the manual retry path, matching
 * the existing chatbox behavior.
 */
const attemptedByProject = new Map<string, Set<string>>();

/**
 * The hostScopeKey we most recently saw for each project. Used to detect a
 * scope-change transition (e.g. user switched hosts) so we can clear the
 * project's prior attempts. Without this, returning to a host you've
 * already visited in the same session would skip reconciliation forever —
 * the dedupe would say "already tried this exact (scope, set) combo" even
 * though the user's host switch is a strong signal they want a fresh
 * attempt.
 */
const lastSeenScopeByProject = new Map<string, string>();

function buildAttemptKey(
  hostScopeKey: string,
  serverNamesKey: string,
): string {
  return `${hostScopeKey}${serverNamesKey}`;
}

function markAttempted(
  projectId: string,
  hostScopeKey: string,
  serverNamesKey: string,
) {
  let set = attemptedByProject.get(projectId);
  if (!set) {
    set = new Set();
    attemptedByProject.set(projectId, set);
  }
  set.add(buildAttemptKey(hostScopeKey, serverNamesKey));
}

function isAttempted(
  projectId: string,
  hostScopeKey: string,
  serverNamesKey: string,
): boolean {
  return (
    attemptedByProject
      .get(projectId)
      ?.has(buildAttemptKey(hostScopeKey, serverNamesKey)) ?? false
  );
}

/**
 * Reset the auto-connect attempted set for a project. Use sparingly — the
 * point of the set is to NOT auto-retry. Exposed for tests and for any
 * future "Retry all" affordance.
 */
export function resetAutoConnectAttempts(projectId?: string): void {
  if (projectId === undefined) {
    attemptedByProject.clear();
    lastSeenScopeByProject.clear();
  } else {
    attemptedByProject.delete(projectId);
    lastSeenScopeByProject.delete(projectId);
  }
}

interface UseAutoConnectProjectServersResult {
  enabled: boolean;
  /** Last batch result; null until a batch has been attempted. */
  lastResult: EnsureServersReadyResult | null;
}

/**
 * Mount once per surface (Servers tab, host page, Playground) with the
 * names of the active/previewed host's REQUIRED servers. On first mount
 * with `requiredServerNames` non-empty, fires `ensureServersReady` for
 * every name whose runtime status is not already
 * connected/connecting/oauth-flow. Dedupes across re-mounts and surfaces
 * via a module-level Set keyed by `(projectId, sortedServerNames)`.
 *
 * Disabled entirely when `autoConnectServersEnabled` is false in the
 * preferences store.
 *
 * Server-set semantics: the caller passes the SAVED host's required set
 * (`HostConfig.serverIds` resolved to names). Required servers auto-connect.
 *
 * Client-switch recycle: switching the active/lead client (a `hostScopeKey`
 * change) reconnects EVERY currently-connected server so each re-runs the MCP
 * `initialize` handshake under the new client identity. It calls the real
 * reconnect path (`reconnectServer` → backend `/api/mcp/servers/reconnect`,
 * which closes and reopens the transport with the new `clientInfo`) once per
 * scope per server — NOT an in-memory disconnect, which left the backend
 * connection alive and made re-handshakes flaky. Required-but-not-connected
 * servers are additionally auto-connected via the candidate path. Gated on a
 * host being active (`hostScopeKey` non-null). Selection is NOT managed here:
 * the connected set is the active set, mirrored by
 * `ActiveClientServerReconciler`.
 */
export function useAutoConnectProjectServers({
  projectId,
  hostScopeKey,
  requiredServerNames,
}: {
  projectId: string | null;
  /**
   * Identifies the scope this batch belongs to — typically the previewed
   * host id. Switching to a different host changes this key, so a batch
   * that already failed on one host gets a fresh shot on the next one.
   * Pass `null` when no host is active; the hook still dedupes within
   * that "no host" scope.
   */
  hostScopeKey: string | null;
  requiredServerNames: ReadonlyArray<string>;
}): UseAutoConnectProjectServersResult {
  const enabled = usePreferencesStore((s) => s.autoConnectServersEnabled);
  const sharedAppState = useSharedAppState();
  const { ensureServersReady, reconnectServer } = useServerActions();
  const lastResultRef = useRef<EnsureServersReadyResult | null>(null);

  const scopeKey = hostScopeKey ?? "-";
  // Stable key for "what the active host wants selected". Drives the
  // playground/chat multi-select sync below, independent of connect /
  // disconnect dedupe.
  const requiredNamesKey = useMemo(
    () => requiredServerNames.slice().sort().join("\0"),
    [requiredServerNames],
  );
  const requiredNames = useMemo(
    () => (requiredNamesKey ? requiredNamesKey.split("\0") : []),
    [requiredNamesKey],
  );

  // Build the candidate name list. Skip servers that are already connected,
  // currently connecting, or in an OAuth flow — connecting/oauth-flow would
  // be interrupted; connected has nothing to do.
  // The candidate pool is the host's required set UNION the servers the
  // currently connecting, or in an OAuth flow — connecting/oauth-flow would
  // be interrupted; connected has nothing to do. This is the "connect the
  // host's required servers" path; reconnecting the ALREADY-connected set on a
  // client switch is handled separately below.
  const candidateNamesKey = useMemo(() => {
    if (!enabled || !projectId || requiredNames.length === 0) {
      return null;
    }
    const candidates = requiredNames.filter((name) => {
      const status = sharedAppState.servers[name]?.connectionStatus;
      return (
        status !== "connected" &&
        status !== "connecting" &&
        status !== "oauth-flow"
      );
    });
    if (candidates.length === 0) return null;
    // Stable key: sorted and joined with NUL so reordering doesn't trigger a
    // fresh batch.
    return candidates.sort().join("\0");
  }, [enabled, projectId, requiredNames, sharedAppState.servers]);

  // Detect a scope transition (user switched the active/lead client) and
  // clear the prior attempt log so revisiting a previously-tried host
  // re-fires reconciliation. Without this, the dedupe set would say
  // "already tried (Claude, [E,b,l])" and skip the second visit forever,
  // even though leaving and coming back is a clear user-intent signal to
  // try again. Sitting on the same host doesn't trigger this — only the
  // actual scope change does. Gated on a host being active (hostScopeKey
  // non-null), not on the required set, so recycling fires even for hosts
  // that declare no required servers.
  useEffect(() => {
    if (!projectId || hostScopeKey == null) return;
    if (lastSeenScopeByProject.get(projectId) !== scopeKey) {
      attemptedByProject.delete(projectId);
      lastSeenScopeByProject.set(projectId, scopeKey);
    }
  }, [projectId, scopeKey, hostScopeKey]);

  // Reconnect-on-client-switch: fires at most once per (project, scopeKey).
  // On switching the active/lead client, every currently-connected server must
  // re-run the MCP `initialize` handshake as the new client. We hit the real
  // reconnect path (`reconnectServer` → backend closes + reopens the transport
  // with the new clientInfo) rather than an in-memory disconnect, which left
  // the backend connection alive and made the re-handshake flaky. We snapshot
  // the connected set at scope entry; servers connected later in the same scope
  // already used the current client, so they're left alone. The module-level
  // scope dedupe makes this fire exactly once even though the hook mounts on
  // several surfaces.
  useEffect(() => {
    if (!enabled || !projectId || hostScopeKey == null) return;
    if (isAttempted(projectId, scopeKey, "recycle")) return;
    markAttempted(projectId, scopeKey, "recycle");
    const connectedNow = Object.entries(sharedAppState.servers)
      .filter(([, server]) => server.connectionStatus === "connected")
      .map(([name]) => name);
    for (const name of connectedNow) {
      reconnectServer(name);
    }
    // `sharedAppState.servers` is read via closure but excluded from deps on
    // purpose: this must fire only on scope transitions, not whenever the
    // connected set changes within a scope. The dedupe gate stops re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectId, scopeKey, hostScopeKey, reconnectServer]);

  // Connect-required: fires when the candidate set (required-but-not-yet-
  // connected) changes. Dedupe is per-server-within-scope, not per
  // candidate-set: once we've attempted `bart` in this scope we never
  // re-attempt it, even if the user toggles it off and back into the
  // candidate set. Without that, user-initiated disconnect of a host-
  // required server would immediately be undone by the next reconcile —
  // wrong behavior for a dev/inspector tool where disconnecting is often
  // intentional (e.g. reproducing a client-side fallback path).
  //
  // Switching hosts clears the project's attempted set (see scope-
  // transition effect above), so re-entering this host gives every
  // required server a fresh attempt.
  useEffect(() => {
    if (!enabled || !projectId || !candidateNamesKey) return;
    const allNames = candidateNamesKey.split("\0");
    const fresh = allNames.filter(
      (name) => !isAttempted(projectId, scopeKey, `srv:${name}`),
    );
    if (fresh.length === 0) return;
    for (const name of fresh) {
      markAttempted(projectId, scopeKey, `srv:${name}`);
    }

    let cancelled = false;
    ensureServersReady(fresh).then(
      (result) => {
        if (cancelled) return;
        lastResultRef.current = result;
      },
      // Swallow rejections — `markAttempted` already ran, so a thrown error
      // is treated identically to a "failed" outcome: the dot stays red,
      // the user clicks to retry. Suppressing here also keeps the
      // "refresh-keeps-failing" guard from generating noisy unhandled
      // rejections in dev/test.
      () => {
        // intentionally empty
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    projectId,
    scopeKey,
    candidateNamesKey,
    ensureServersReady,
  ]);

  return { enabled, lastResult: lastResultRef.current };
}
