/**
 * STACK STUB — the real implementation lands with PR #2129
 * (`mhi/playground-routing`, commit dc32d39e3) and depends on a
 * `state/server-actions-context` module that does not yet exist on any
 * branch in this stack. This stub preserves the public signature so the
 * hosts-redesign branch (#2128) builds and runs standalone; the real
 * auto-connect reconciliation kicks in once #2129 merges on top.
 *
 * Do not extend this stub. If you need auto-connect behaviour here,
 * rebase onto / merge #2129 first.
 */
export interface UseAutoConnectProjectServersResult {
  lastEnsureResult: null;
}

export function useAutoConnectProjectServers(_args: {
  projectId: string | null;
  hostScopeKey: string | null;
  requiredServerNames: ReadonlyArray<string>;
}): UseAutoConnectProjectServersResult {
  return { lastEnsureResult: null };
}
