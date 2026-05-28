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
  // Latest multi-select, read inside the seed effect below WITHOUT making it
  // an effect dependency. Depending on it would re-run the merge every time
  // the selection changes (e.g. the user toggling a server off), which could
  // undo a deliberate deselect. The seed should react only to host-scope /
  // required-set changes, so we read the live value through a ref instead.
  const selectedNamesRef = useRef(sharedAppState.selectedMultipleServers);
  selectedNamesRef.current = sharedAppState.selectedMultipleServers;
  // Which (project, host-scope) we last seeded the selection for. Component-
  // scoped on purpose: the hook mounts on several surfaces (reconciler,
  // Servers tab, Playground, Client builder) with DIFFERENT scopes, so a
  // shared module map would thrash. Each mount seeds its own scope at most
  // once and merges thereafter.
  const seededSelectionScopeRef = useRef<string | null>(null);

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

  // Names in the active host's required set that are currently connected.
  // On a host switch, only those servers need to be recycled so they can
  // reconnect with the new host's initialize payload. Servers outside the
  // required set may have been connected manually or by the project-level
  // auto-connect switch; entering a host with no required servers must not
  // tear them down.
  const requiredConnectedNamesToDisconnectKey = useMemo(() => {
    if (!enabled || !projectId || requiredNames.length === 0) return null;
    const connected: string[] = [];
    for (const name of requiredNames) {
      if (sharedAppState.servers[name]?.connectionStatus !== "connected") {
        continue;
      }
      connected.push(name);
    }
    if (connected.length === 0) return null;
    return connected.join("\0");
  }, [enabled, projectId, requiredNames, sharedAppState.servers]);

  // Build the candidate name list. Skip servers that are already connected,
  // currently connecting, or in an OAuth flow — connecting/oauth-flow would
  // be interrupted; connected has nothing to do.
  const candidateNamesKey = useMemo(() => {
    if (!enabled || !projectId || requiredNames.length === 0) {
      return null;
    }
    const candidates: string[] = [];
    for (const name of requiredNames) {
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
    return candidates.join("\0");
  }, [enabled, projectId, requiredNames, sharedAppState.servers]);

  // Seed the playground/chat multi-select from the active host's required
  // set. On a host switch (scopeKey change, or the first resolve for this
  // surface) we REPLACE the selection so the preview matches the picked
  // client. Within the SAME scope, though, the required set can re-resolve
  // for reasons that are NOT a host switch — most commonly, connecting
  // another server updates the project's server catalog so a host-referenced
  // id that didn't resolve before now does. Replacing there silently wiped
  // servers the user had toggled on by hand: they stayed connected but
  // dropped out of the selection (their toggle flipped off). So for an
  // in-scope change we MERGE the required names into the current selection
  // instead, never removing the user's manual picks. Empty required sets are
  // a no-op so surfaces with no explicit host don't clear the selection.
  useEffect(() => {
    if (!enabled || !projectId || requiredNames.length === 0) return;

    const seedKey = `${projectId}::${scopeKey}`;
    if (seededSelectionScopeRef.current !== seedKey) {
      seededSelectionScopeRef.current = seedKey;
      setSelectedServerNames(requiredNames);
      return;
    }

    const current = selectedNamesRef.current ?? [];
    const merged = current.slice();
    for (const name of requiredNames) {
      if (!merged.includes(name)) merged.push(name);
    }
    if (merged.length !== current.length) {
      setSelectedServerNames(merged);
    }
  }, [enabled, projectId, scopeKey, requiredNames, setSelectedServerNames]);

  // Detect a scope transition (user switched the previewed host) and
  // clear the prior attempt log so revisiting a previously-tried host
  // re-fires reconciliation. Without this, the dedupe set would say
  // "already tried (Claude, [E,b,l])" and skip the second visit forever,
  // even though leaving and coming back is a clear user-intent signal to
  // try again. Sitting on the same host doesn't trigger this — only the
  // actual scope change does.
  useEffect(() => {
    if (!projectId || requiredNames.length === 0) return;
    if (lastSeenScopeByProject.get(projectId) !== scopeKey) {
      attemptedByProject.delete(projectId);
      lastSeenScopeByProject.set(projectId, scopeKey);
    }
  }, [projectId, scopeKey, requiredNames.length]);

  // Disconnect-required-connected: fires at most once per (project,
  // scopeKey). This is the host-switch recycle pass — it snapshots the
  // active host's required servers that are already connected on first
  // entry to the scope and disconnects only those. They then re-enter the
  // candidate set on the next render and reconnect fresh. Later changes
  // to the connected set within the SAME scope (e.g. the user manually
  // connecting an additional server from the Servers tab) must not re-
  // fire this path, otherwise we'd tear down servers the user just
  // intentionally connected. The dedupe key is scope-only and we mark
  // attempted unconditionally on first run, so subsequent renders bail
  // even if `requiredConnectedNamesToDisconnectKey` becomes non-null
  // afterwards.
  useEffect(() => {
    if (!enabled || !projectId || requiredNames.length === 0) return;
    if (isAttempted(projectId, scopeKey, "disconnect")) return;
    markAttempted(projectId, scopeKey, "disconnect");
    if (!requiredConnectedNamesToDisconnectKey) return;
    for (const name of requiredConnectedNamesToDisconnectKey.split("\0")) {
      runtimeDisconnectServer(name);
    }
    // `requiredConnectedNamesToDisconnectKey` is intentionally excluded from
    // the dep array: this effect must fire only on scope transitions, not
    // when the user's actions change the set of connected servers within
    // the same scope. Reading the latest value via closure is fine because
    // the dedupe gate stops re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    projectId,
    scopeKey,
    requiredNames.length,
    runtimeDisconnectServer,
  ]);

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
