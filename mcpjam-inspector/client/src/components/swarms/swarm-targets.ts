/**
 * Per-TARGET column/keying model for the Swarms run matrix + journey list
 * (Project Environments — B6/D2). An execution target is one `snapshot.hosts[]`
 * entry: a legacy host or a project environment; two environments may share a
 * host and must stay distinct columns.
 *
 * Canonical key: `targetId ?? hostId`, with HOST-SHAPED target ids collapsed to
 * the bare hostId — mirroring the backend rollup's `outcomeKeyOf`, so fresh
 * legacy runs (whose summaries DO carry a `host:<id>` targetId) key identically
 * to pre-environments historical rows (which carry none). The comparison
 * CONSTRUCTS the host-shaped id for equality; it never parses an opaque id.
 */
import type {
  JourneyHostSummary,
  JourneySnapshotTarget,
} from "@/lib/swarm-api";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import type { SwarmSessionTargetIdentity } from "@/shared/swarm-session-id";
import { swarmAttemptChatSessionId } from "@/shared/swarm-session-id";
import {
  disambiguateLabels,
  environmentLabel,
  trimOrUndefined,
} from "@/lib/environment-label";

/** One matrix/list column. `key` is the canonical target key (D2); `identity`
 * feeds the shared session-id mint. */
export interface SwarmTargetColumn {
  key: string;
  hostId: string;
  targetId?: string;
  environmentId?: string;
  /** Display label: environment name (env targets) or host name; `#n`-suffixed
   * on collisions. */
  label: string;
  identity: SwarmSessionTargetIdentity;
}

/** The backend's one production spelling of a host-shaped target id —
 * constructed only for EQUALITY checks (mirrors `hostTargetId`). */
function hostShapedTargetId(hostId: string): string {
  return `host:${hostId}`;
}

/** Canonical key for a summary/rollup row: `targetId ?? hostId`, with
 * host-shaped ids collapsed to the bare hostId (backend `outcomeKeyOf`). */
export function summaryTargetKey(row: {
  hostId: string;
  targetId?: string;
}): string {
  if (row.targetId === undefined) return row.hostId;
  if (row.targetId === hostShapedTargetId(row.hostId)) return row.hostId;
  return row.targetId;
}

// `disambiguateLabels` moved to `@/lib/environment-label` — ad-hoc environments
// derive their label from the client name, so label collisions became the norm
// rather than the exception and the Environments surfaces need it too.

/**
 * Build the run-detail matrix columns: one per `hostSummaries` row (run order),
 * joined to `snapshot.hosts` by targetId (fallback: first snapshot entry with
 * the same host). Env targets label by environment name; host targets by the
 * LIVE project host name, then the snapshot's `hostName`, then a truncated id.
 *
 * `hostName` MUST return `undefined` for a host no longer in the project so the
 * snapshot fallback is reachable — a caller that folds its own `id.slice(0, 8)`
 * into the lookup makes historical runs render truncated ids instead of the
 * name the run was launched with. The truncation fallback lives HERE, once.
 */
export function buildSwarmRunTargets(args: {
  hostSummaries: Array<Pick<JourneyHostSummary, "hostId" | "targetId">>;
  snapshotHosts?: JourneySnapshotTarget[];
  hostName: (hostId: string) => string | undefined;
}): SwarmTargetColumn[] {
  const { hostSummaries, snapshotHosts, hostName } = args;
  const columns = hostSummaries.map((summary) => {
    const snap =
      (summary.targetId !== undefined
        ? snapshotHosts?.find((h) => h.targetId === summary.targetId)
        : undefined) ?? snapshotHosts?.find((h) => h.hostId === summary.hostId);
    const environmentId = snap?.environmentRef?.environmentId;
    // `trimOrUndefined`, NOT `??`. The backend types `environmentRef.name` as a
    // required string (it is baked into two historical run-snapshot schemas), so
    // an ad-hoc target can snapshot an EMPTY name rather than an absent one —
    // and `??` would pass `""` straight through, blanking the column label.
    const label =
      trimOrUndefined(snap?.environmentRef?.name) ??
      hostName(summary.hostId) ??
      snap?.hostName ??
      summary.hostId.slice(0, 8);
    return {
      key: summaryTargetKey(summary),
      hostId: summary.hostId,
      ...(summary.targetId !== undefined ? { targetId: summary.targetId } : {}),
      ...(environmentId !== undefined ? { environmentId } : {}),
      label,
      identity: {
        hostId: summary.hostId,
        ...(environmentId !== undefined ? { environmentId } : {}),
      },
    } satisfies SwarmTargetColumn;
  });
  return disambiguateLabels(columns);
}

/**
 * Journey-list columns for a journey that has NOT run yet (no summaries to key
 * off): env-based journeys get one column per environment in `environmentIds`
 * order (joined to the live environments list); legacy journeys one per host.
 */
export function buildUnrunJourneyTargets(args: {
  hostIds: string[];
  environmentIds?: string[] | null;
  environments?: ProjectEnvironmentView[];
  hostName: (hostId: string) => string;
}): SwarmTargetColumn[] {
  const { hostIds, environmentIds, environments, hostName } = args;
  if (environmentIds && environmentIds.length > 0) {
    const columns = environmentIds.map((environmentId) => {
      const env = environments?.find((e) => e.environmentId === environmentId);
      const hostId = env?.hostId ?? "";
      return {
        key: `environment:${environmentId}`,
        hostId,
        targetId: `environment:${environmentId}`,
        environmentId,
        // `slice(0, 8)` is for a row missing from the live list ENTIRELY (a
        // deleted/archived id) — a different failure from a row that simply has
        // no name, which `environmentLabel` covers with the client name.
        label: env
          ? environmentLabel(env, { hostName })
          : environmentId.slice(0, 8),
        identity: { hostId, environmentId },
      } satisfies SwarmTargetColumn;
    });
    return disambiguateLabels(columns);
  }
  return disambiguateLabels(
    hostIds.map((hostId) => ({
      key: hostId,
      hostId,
      label: hostName(hostId),
      identity: { hostId },
    }))
  );
}

/**
 * Deep-link / initial-selection restore: find the (target, sessionIndex) cell
 * whose minted chatSessionId matches a persisted session row's. Bounded
 * (≤ targets × sessionsPerTarget).
 */
export function findTargetCellForChatSessionId(args: {
  runId: string;
  targets: SwarmTargetColumn[];
  sessionsPerTarget: number;
  chatSessionId: string;
}): { target: SwarmTargetColumn; sessionIndex: number } | null {
  const { runId, targets, sessionsPerTarget, chatSessionId } = args;
  for (const target of targets) {
    for (let sessionIndex = 0; sessionIndex < sessionsPerTarget; sessionIndex++) {
      if (
        swarmAttemptChatSessionId(runId, target.identity, sessionIndex) ===
        chatSessionId
      ) {
        return { target, sessionIndex };
      }
    }
  }
  return null;
}
