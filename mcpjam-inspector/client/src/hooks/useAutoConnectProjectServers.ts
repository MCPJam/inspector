import { useEffect, useMemo, useRef } from "react";
import type { EnsureServersReadyResult } from "@/hooks/use-server-state";
import { useSharedAppState } from "@/state/app-state-context";
import { useServerActions } from "@/state/server-actions-context";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/**
 * Module-level memo of "we already kicked off ensureServersReady for this
 * (project, host-scope, server-name set)". Lives outside React state on
 * purpose: navigating Servers → Host → Playground re-mounts the hook
 * three times but should only fire one batch per scope. Cleared per-project
 * on entry so switching projects starts fresh.
 *
 * Concretely: this is the "refresh-keeps-failing" guard. Once a batch has
 * been attempted — regardless of whether it succeeded, failed, or stalled
 * on a bad refresh token — we never retry it automatically for the SAME
 * host. Switching to a different host counts as a different scope, so the
 * user can recover from a transient failure by switching hosts. Otherwise
 * the per-card connect toggle in the Servers tab is the manual retry path,
 * matching the existing chatbox behavior.
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
 * (`HostConfig.serverIds` resolved to names). Optional servers stay
 * disconnected; if the host has no required servers, this hook is a
 * no-op. This matches the host's declared dependencies — connecting
 * servers the host doesn't claim to need would be surprising.
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
  const {
    ensureServersReady,
    runtimeDisconnectServer,
    setSelectedServerNames,
  } = useServerActions();
  const lastResultRef = useRef<EnsureServersReadyResult | null>(null);

  // Names currently in a "connected" runtime state that the active host
  // does NOT require — these get torn down on host switch so the runtime
  // matches what the active host actually declares it needs. We compute
  // this separately from the connect candidates so the dedupe key can
  // cover both directions of reconciliation. Skipped when no project is
  // active or when auto-connect is toggled off (the toggle gates both
  // directions — it's "auto-reconcile to host", not just "auto-connect").
  const excessConnectedNamesKey = useMemo(() => {
    if (!enabled || !projectId) return null;
    const requiredSet = new Set(requiredServerNames);
    const excess: string[] = [];
    for (const [name, server] of Object.entries(sharedAppState.servers)) {
      if (requiredSet.has(name)) continue;
      if (server?.connectionStatus !== "connected") continue;
      excess.push(name);
    }
    if (excess.length === 0) return null;
    return excess.slice().sort().join("\0");
  }, [enabled, projectId, requiredServerNames, sharedAppState.servers]);

  // Build the candidate name list. Skip servers that are already connected,
  // currently connecting, or in an OAuth flow — connecting/oauth-flow would
  // be interrupted; connected has nothing to do.
  const candidateNamesKey = useMemo(() => {
    if (!enabled || !projectId || requiredServerNames.length === 0) {
      return null;
    }
    const candidates: string[] = [];
    for (const name of requiredServerNames) {
      const status = sharedAppState.servers[name]?.connectionStatus;
      if (
        status === "connected" ||
        status === "connecting" ||
        status === "oauth-flow"
      ) {
        continue;
      }
      candidates.push(name);
    }
    if (candidates.length === 0) return null;
    // Stable key: sorted and joined with NUL — same shape ChatboxBuilderView
    // uses (line 754) so reordering doesn't trigger a fresh batch.
    return candidates.slice().sort().join("\0");
  }, [enabled, projectId, requiredServerNames, sharedAppState.servers]);

  const scopeKey = hostScopeKey ?? "-";
  // Stable key for "what the active host wants selected". Drives the
  // playground/chat multi-select sync below, independent of connect /
  // disconnect dedupe — so switching from one zero-required host to
  // another still clears the previous selection.
  const requiredNamesKey = useMemo(
    () => requiredServerNames.slice().sort().join("\0"),
    [requiredServerNames],
  );

  // Sync the playground/chat multi-select to the host's required set
  // whenever the (project, hostScope, required-names) tuple changes.
  // React's dep comparison deduplicates re-renders that don't actually
  // change the tuple, so this fires once per host switch (and once per
  // edit to the host's required set after save).
  useEffect(() => {
    if (!enabled || !projectId) return;
    setSelectedServerNames(requiredNamesKey ? requiredNamesKey.split("\0") : []);
  }, [
    enabled,
    projectId,
    scopeKey,
    requiredNamesKey,
    setSelectedServerNames,
  ]);

  // Detect a scope transition (user switched the previewed host) and
  // clear the prior attempt log so revisiting a previously-tried host
  // re-fires reconciliation. Without this, the dedupe set would say
  // "already tried (Claude, [E,b,l])" and skip the second visit forever,
  // even though leaving and coming back is a clear user-intent signal to
  // try again. Sitting on the same host doesn't trigger this — only the
  // actual scope change does.
  useEffect(() => {
    if (!projectId) return;
    if (lastSeenScopeByProject.get(projectId) !== scopeKey) {
      attemptedByProject.delete(projectId);
      lastSeenScopeByProject.set(projectId, scopeKey);
    }
  }, [projectId, scopeKey]);

  // Compose the reconciliation key from both connect and disconnect sets.
  // Same scopeKey with the same connect+disconnect intent = skip; any
  // change in either side counts as a fresh reconciliation. The `c:` / `d:`
  // prefixes prevent accidental cross-talk when one side is null.
  const reconciliationKey = useMemo(() => {
    if (!enabled || !projectId) return null;
    if (!candidateNamesKey && !excessConnectedNamesKey) return null;
    return `c:${candidateNamesKey ?? ""}|d:${excessConnectedNamesKey ?? ""}`;
  }, [enabled, projectId, candidateNamesKey, excessConnectedNamesKey]);

  useEffect(() => {
    if (!enabled || !projectId || !reconciliationKey) return;
    if (isAttempted(projectId, scopeKey, reconciliationKey)) return;
    markAttempted(projectId, scopeKey, reconciliationKey);

    // Tear down anything connected the host doesn't require. Fire-and-
    // forget — `runtimeDisconnectServer` is a synchronous dispatch.
    if (excessConnectedNamesKey) {
      for (const name of excessConnectedNamesKey.split("\0")) {
        runtimeDisconnectServer(name);
      }
    }

    if (!candidateNamesKey) return;
    let cancelled = false;
    const names = candidateNamesKey.split("\0");
    ensureServersReady(names).then(
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
    reconciliationKey,
    candidateNamesKey,
    excessConnectedNamesKey,
    ensureServersReady,
    runtimeDisconnectServer,
  ]);

  return { enabled, lastResult: lastResultRef.current };
}
