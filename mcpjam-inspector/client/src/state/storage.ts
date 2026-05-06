/**
 * Convex is now the single source of truth for projects/servers/state.
 * `loadAppState` and `saveAppState` are no-ops post-unification: state
 * hydrates from Convex queries, and the migration shim
 * (`lib/local-state-migration.ts`) lifts any legacy localStorage state on
 * first boot. The legacy keys (`mcp-inspector-state`,
 * `mcp-inspector-projects`, `mcp-inspector-workspaces`) live just long
 * enough for the migration to read them — `clearLegacyKeys()` removes them
 * after a successful migration.
 *
 * Persisted OAuth-trace cleanup still runs because that's a UI-only artifact
 * unrelated to project state.
 */
import { AppState, createInitialAppState } from "./app-types";
import { clearPersistedOAuthTraces } from "@/lib/oauth/oauth-trace";

export function loadAppState(): AppState {
  try {
    clearPersistedOAuthTraces();
  } catch {
    // best-effort
  }
  return createInitialAppState();
}

export function saveAppState(_state: AppState) {
  // Intentionally empty. Convex is the source of truth; localStorage is no
  // longer written for project/server state.
}
