import { AppState, createInitialAppState } from "./app-types";
import { clearPersistedOAuthTraces } from "@/lib/oauth/oauth-trace";

/**
 * Storage layer for legacy localStorage-backed AppState.
 *
 * Slice 4: collapsed to no-ops. Convex is the only source of truth for
 * projects/servers in both modes. Legacy localStorage state is migrated to
 * Convex once on first boot by `lib/local-state-migration.ts`; subsequent
 * state lives in Convex and is read via `useProjectQueries` /
 * `useProjectServers`. The `loadAppState` / `saveAppState` exports remain so
 * existing call sites keep compiling, but they no longer touch localStorage.
 *
 * Persisted OAuth traces in `sessionStorage` are still cleared on first read
 * — the trace pruning is a UI concern, not state persistence.
 */

export function loadAppState(): AppState {
  clearPersistedOAuthTraces();
  return createInitialAppState();
}

export function saveAppState(_state: AppState): void {
  // no-op
}
