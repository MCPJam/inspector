/**
 * Env-based journey payload helpers (Project Environments — B5).
 *
 * An env-based journey stores `hostIds: []`. It used to store a list DERIVED
 * from the selected environments' hosts, purely to satisfy a backend check
 * that required at least one — a duplicate of information the environments
 * already carried, and one that silently went stale the moment an environment
 * was repointed at a different host. Nothing ever read it: env resolution
 * takes the hosts from the environments themselves.
 *
 * Clearing BACK to legacy is the one case that still needs real hosts, and it
 * computes them at that moment from the journey's current environments — see
 * {@link buildClearToLegacyPayload}.
 */
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

export const MAX_ENVIRONMENTS_PER_JOURNEY = 10;

/** Selected envs' resolved hostIds, deduped, in selection order. Unknown env
 * ids (not in the live list) resolve to nothing. */
export function compatHostIdsForEnvironments(
  environmentIds: string[],
  environments: ProjectEnvironmentView[],
): string[] {
  const out: string[] = [];
  for (const environmentId of environmentIds) {
    const env = environments.find((e) => e.environmentId === environmentId);
    if (env?.hostId && !out.includes(env.hostId)) out.push(env.hostId);
  }
  return out;
}

/**
 * Payload for an env-mode create/edit: `environmentIds` plus an EMPTY
 * `hostIds`, which the backend now accepts for env-based journeys.
 *
 * Returns null when the selection is unusable and the caller must block the
 * write: no selection, or an id that does NOT resolve in the live list
 * (archived/deleted — persisting it would leave a target that can never
 * launch). It no longer returns null merely because no host could be derived;
 * that check only ever existed to satisfy the old ≥1-host requirement, and it
 * rejected a perfectly valid selection whose environments happened to resolve
 * to nothing this client had loaded.
 */
export function buildEnvJourneyPayload(
  environmentIds: string[],
  environments: ProjectEnvironmentView[],
): { environmentIds: string[]; hostIds: string[] } | null {
  if (environmentIds.length === 0) return null;
  // Reject unresolved ids rather than silently persisting them: every selected
  // environment must exist in the live list. A stale archived/deleted id must
  // be removed from the selection before the journey can be saved.
  const allResolve = environmentIds.every((id) =>
    environments.some((e) => e.environmentId === id),
  );
  if (!allResolve) return null;
  return { environmentIds, hostIds: [] };
}

/**
 * Payload for clearing an env-based journey back to legacy: `environmentIds:
 * null` + compat `hostIds` recomputed from the journey's CURRENT environment
 * definitions in the SAME update call. Returns null when no valid compat host
 * resolves (clear must be blocked — the user has to pick clients instead).
 */
export function buildClearToLegacyPayload(
  currentEnvironmentIds: string[],
  environments: ProjectEnvironmentView[],
): { environmentIds: null; hostIds: string[] } | null {
  const hostIds = compatHostIdsForEnvironments(
    currentEnvironmentIds,
    environments,
  );
  if (hostIds.length === 0) return null;
  return { environmentIds: null, hostIds };
}
