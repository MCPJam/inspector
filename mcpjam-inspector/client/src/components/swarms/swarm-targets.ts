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
  EnvironmentView,
  JourneyHostSummary,
  JourneySnapshotTarget,
} from "@/lib/swarm-api";
import type { SwarmSessionTargetIdentity } from "@/shared/swarm-session-id";
import { swarmAttemptChatSessionId } from "@/shared/swarm-session-id";

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

/** Disambiguate duplicate labels with a stable `#n` suffix (collision groups
 * only; unique labels stay untouched). */
function disambiguateLabels(columns: SwarmTargetColumn[]): SwarmTargetColumn[] {
  const counts = new Map<string, number>();
  for (const c of columns) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return columns.map((c) => {
    if ((counts.get(c.label) ?? 0) <= 1) return c;
    const n = (seen.get(c.label) ?? 0) + 1;
    seen.set(c.label, n);
    return { ...c, label: `${c.label} #${n}` };
  });
}

/**
 * Build the run-detail matrix columns: one per `hostSummaries` row (run order),
 * joined to `snapshot.hosts` by targetId (fallback: first snapshot entry with
 * the same host). Env targets label by environment name; host targets by the
 * project host name (fallback: snapshot hostName, then a truncated id).
 */
export function buildSwarmRunTargets(args: {
  hostSummaries: Array<Pick<JourneyHostSummary, "hostId" | "targetId">>;
  snapshotHosts?: JourneySnapshotTarget[];
  hostName: (hostId: string) => string;
}): SwarmTargetColumn[] {
  const { hostSummaries, snapshotHosts, hostName } = args;
  const columns = hostSummaries.map((summary) => {
    const snap =
      (summary.targetId !== undefined
        ? snapshotHosts?.find((h) => h.targetId === summary.targetId)
        : undefined) ??
      snapshotHosts?.find((h) => h.hostId === summary.hostId);
    const environmentId = snap?.environmentRef?.environmentId;
    const label =
      snap?.environmentRef?.name ??
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
  environments?: EnvironmentView[];
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
        label: env?.name ?? environmentId.slice(0, 8),
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
    })),
  );
}

/**
 * Deep-link / initial-selection restore: find the (target, sessionIndex) cell
 * whose minted chatSessionId matches a persisted session row's. Bounded
 * (≤ targets × sessionsPerHost).
 */
export function findTargetCellForChatSessionId(args: {
  runId: string;
  targets: SwarmTargetColumn[];
  sessionsPerHost: number;
  chatSessionId: string;
}): { target: SwarmTargetColumn; sessionIndex: number } | null {
  const { runId, targets, sessionsPerHost, chatSessionId } = args;
  for (const target of targets) {
    for (let sessionIndex = 0; sessionIndex < sessionsPerHost; sessionIndex++) {
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
