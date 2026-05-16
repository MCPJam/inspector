import { useEffect, useMemo, useRef } from "react";
import type { EnsureServersReadyResult } from "@/hooks/use-server-state";
import { useSharedAppState } from "@/state/app-state-context";
import { useServerActions } from "@/state/server-actions-context";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/**
 * Module-level memo of "we already kicked off ensureServersReady for this
 * (project, server-name set)". Lives outside React state on purpose:
 * navigating Servers → Host → Playground re-mounts the hook three times
 * but should only fire one batch per session. Cleared per-project on entry
 * so switching projects starts fresh.
 *
 * Concretely: this is the "refresh-keeps-failing" guard. Once a batch has
 * been attempted — regardless of whether it succeeded, failed, or stalled
 * on a bad refresh token — we never retry it automatically. The user's
 * manual click on the per-card connect toggle in the Servers tab is the
 * only retry path, matching the existing chatbox behavior.
 */
const attemptedByProject = new Map<string, Set<string>>();

function markAttempted(projectId: string, serverNamesKey: string) {
  let set = attemptedByProject.get(projectId);
  if (!set) {
    set = new Set();
    attemptedByProject.set(projectId, set);
  }
  set.add(serverNamesKey);
}

function isAttempted(projectId: string, serverNamesKey: string): boolean {
  return attemptedByProject.get(projectId)?.has(serverNamesKey) ?? false;
}

/**
 * Reset the auto-connect attempted set for a project. Use sparingly — the
 * point of the set is to NOT auto-retry. Exposed for tests and for any
 * future "Retry all" affordance.
 */
export function resetAutoConnectAttempts(projectId?: string): void {
  if (projectId === undefined) {
    attemptedByProject.clear();
  } else {
    attemptedByProject.delete(projectId);
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
  requiredServerNames,
}: {
  projectId: string | null;
  requiredServerNames: ReadonlyArray<string>;
}): UseAutoConnectProjectServersResult {
  const enabled = usePreferencesStore((s) => s.autoConnectServersEnabled);
  const sharedAppState = useSharedAppState();
  const { ensureServersReady } = useServerActions();
  const lastResultRef = useRef<EnsureServersReadyResult | null>(null);

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

  useEffect(() => {
    if (!enabled || !projectId || !candidateNamesKey) return;
    if (isAttempted(projectId, candidateNamesKey)) return;
    markAttempted(projectId, candidateNamesKey);
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
  }, [enabled, projectId, candidateNamesKey, ensureServersReady]);

  return { enabled, lastResult: lastResultRef.current };
}
