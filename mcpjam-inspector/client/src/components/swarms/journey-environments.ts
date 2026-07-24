/**
 * Env-based journey payload helpers (Project Environments — B5).
 *
 * INVARIANT: every write that touches `environmentIds` ALSO recomputes the
 * compat `hostIds` from the selected environments' resolved hosts — deduped,
 * in selection order — so the legacy rollback data can never go stale. The
 * backend keeps `hostIds` as inactive compatibility data on env-based journeys
 * and reads it again only after a clear-to-legacy.
 */
import type { EnvironmentView } from "@/lib/swarm-api";

export const MAX_ENVIRONMENTS_PER_JOURNEY = 10;

/** Selected envs' resolved hostIds, deduped, in selection order. Unknown env
 * ids (not in the live list) resolve to nothing. */
export function compatHostIdsForEnvironments(
  environmentIds: string[],
  environments: EnvironmentView[],
): string[] {
  const out: string[] = [];
  for (const environmentId of environmentIds) {
    const env = environments.find((e) => e.environmentId === environmentId);
    if (env?.hostId && !out.includes(env.hostId)) out.push(env.hostId);
  }
  return out;
}

/**
 * Payload for an env-mode create/edit: `environmentIds` + recomputed compat
 * `hostIds`. Returns null when the selection is unusable and the caller must
 * block the write: no selection, an id that does NOT resolve in the live list
 * (archived/deleted — persisting it would leave a target that can never
 * launch), or no compat host (the backend requires ≥1 hostId).
 */
export function buildEnvJourneyPayload(
  environmentIds: string[],
  environments: EnvironmentView[],
): { environmentIds: string[]; hostIds: string[] } | null {
  if (environmentIds.length === 0) return null;
  // Reject unresolved ids rather than silently persisting them: every selected
  // environment must exist in the live list. A stale archived/deleted id must
  // be removed from the selection before the journey can be saved.
  const allResolve = environmentIds.every((id) =>
    environments.some((e) => e.environmentId === id),
  );
  if (!allResolve) return null;
  const hostIds = compatHostIdsForEnvironments(environmentIds, environments);
  if (hostIds.length === 0) return null;
  return { environmentIds, hostIds };
}

/**
 * Payload for clearing an env-based journey back to legacy: `environmentIds:
 * null` + compat `hostIds` recomputed from the journey's CURRENT environment
 * definitions in the SAME update call. Returns null when no valid compat host
 * resolves (clear must be blocked — the user has to pick clients instead).
 */
export function buildClearToLegacyPayload(
  currentEnvironmentIds: string[],
  environments: EnvironmentView[],
): { environmentIds: null; hostIds: string[] } | null {
  const hostIds = compatHostIdsForEnvironments(
    currentEnvironmentIds,
    environments,
  );
  if (hostIds.length === 0) return null;
  return { environmentIds: null, hostIds };
}
