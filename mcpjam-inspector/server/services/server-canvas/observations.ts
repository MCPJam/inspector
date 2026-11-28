/**
 * Observed evidence (engineering spec v0.4, "3. Observed"): the feature ids a
 * connection's traffic showed, tallied per server and written in batches to
 * `serverFeatureObservations:recordFeatureObservations`.
 *
 * Only feature ids, counts and times are kept; no payload, URI, name or
 * message reaches this module. A flush rechecks the `server-canvas` rollout
 * for the flushing identity and drops everything when it is off.
 */
import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type FunctionArgs } from "convex/server";
import type { ObservationSource } from "@mcpjam/sdk";
import { getInspectorClientRuntimeConfig } from "../../env.js";
import { logger } from "../../utils/logger.js";

/** The backend accepts at most this many observations per call. */
export const MAX_OBSERVATIONS_PER_WRITE = 200;
/** Counts are capped so a long session cannot grow a number without bound. */
export const MAX_OBSERVATION_COUNT = 1_000_000;
/** Targets one buffer tallies before it ignores new ones until a flush. */
export const MAX_BUFFERED_SERVERS = 256;

export interface ObservationTally {
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  source: ObservationSource;
}

type Tallies = Map<string, ObservationTally>;

function mergeTally(
  into: Tallies,
  featureId: string,
  next: ObservationTally,
): void {
  const current = into.get(featureId);
  if (!current) {
    into.set(featureId, { ...next });
    return;
  }
  current.count = Math.min(MAX_OBSERVATION_COUNT, current.count + next.count);
  current.firstSeenAt = Math.min(current.firstSeenAt, next.firstSeenAt);
  if (next.lastSeenAt >= current.lastSeenAt) {
    current.lastSeenAt = next.lastSeenAt;
    current.source = next.source;
  }
}

/** Where observations are written: a project server under one context. */
export interface ObservationTarget {
  projectId: string;
  /** Project server id (the Convex `servers` id). */
  serverId: string;
  contextHash: string;
}

type TargetTallies = { target: ObservationTarget; tallies: Tallies };

/** Tallies of observed feature ids per target, drained by each flush. */
export class FeatureObservationBuffer {
  private targets = new Map<string, TargetTallies>();

  record(
    target: ObservationTarget,
    featureIds: readonly string[],
    at: number,
    source: ObservationSource,
    count = 1,
  ): void {
    const key = JSON.stringify([
      target.projectId,
      target.serverId,
      target.contextHash,
    ]);
    let entry = this.targets.get(key);
    if (!entry) {
      if (this.targets.size >= MAX_BUFFERED_SERVERS) return;
      entry = { target: { ...target }, tallies: new Map() };
      this.targets.set(key, entry);
    }
    for (const featureId of featureIds)
      mergeTally(entry.tallies, featureId, {
        count,
        firstSeenAt: at,
        lastSeenAt: at,
        source,
      });
  }

  get size(): number {
    return this.targets.size;
  }

  take(): TargetTallies[] {
    const drained = [...this.targets.values()];
    this.targets = new Map();
    return drained;
  }
}

export const recordFeatureObservationsMutation = makeFunctionReference<
  "mutation",
  {
    projectId: string;
    serverId: string;
    contextHash: string;
    flushId: string;
    observations: Array<{
      featureId: string;
      count: number;
      firstSeenAt: number;
      lastSeenAt: number;
      source: ObservationSource;
    }>;
  }
>("serverFeatureObservations:recordFeatureObservations");

export type FeatureObservationWrite = FunctionArgs<
  typeof recordFeatureObservationsMutation
>;

export interface ObservationFlushDeps {
  /** The `server-canvas` rollout for the flushing identity, asked now. */
  canvasOn: () => Promise<boolean>;
  write: (args: FeatureObservationWrite) => Promise<void>;
}

/** Writes to Convex as the user behind `authorization`. */
export function convexObservationWriter(
  authorization: string | null | undefined,
): (args: FeatureObservationWrite) => Promise<void> {
  const bearer = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return async (args) => {
    const { convexUrl } = getInspectorClientRuntimeConfig();
    if (!convexUrl || !bearer) return;
    const client = new ConvexHttpClient(convexUrl);
    client.setAuth(bearer);
    await client.mutation(recordFeatureObservationsMutation, args);
  };
}

/** One write, retried once with the same `flushId` so a retry is idempotent. */
export async function writeObservationBatch(
  write: ObservationFlushDeps["write"],
  args: FeatureObservationWrite,
): Promise<boolean> {
  try {
    await write(args);
    return true;
  } catch (firstError) {
    try {
      await write(args);
      return true;
    } catch (error) {
      logger.warn("[server-canvas] Could not save observed features", {
        projectId: args.projectId,
        serverId: args.serverId,
        observations: args.observations.length,
        error: error instanceof Error ? error.message : String(error),
        firstError:
          firstError instanceof Error ? firstError.message : String(firstError),
      });
      return false;
    }
  }
}

/**
 * Drains `buffer` and writes each target's tallies in calls of at most
 * {@link MAX_OBSERVATIONS_PER_WRITE}. Never throws. With the rollout off for
 * the flushing identity, the drained observations are dropped unwritten.
 */
export async function flushFeatureObservations(
  buffer: FeatureObservationBuffer,
  deps: ObservationFlushDeps,
): Promise<{ writes: number; observations: number }> {
  const drained = buffer.take();
  const outcome = { writes: 0, observations: 0 };
  if (drained.length === 0) return outcome;
  if (!(await deps.canvasOn().catch(() => false))) return outcome;
  for (const { target, tallies } of drained) {
    const observations = [...tallies]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([featureId, tally]) => ({ featureId, ...tally }));
    for (
      let start = 0;
      start < observations.length;
      start += MAX_OBSERVATIONS_PER_WRITE
    ) {
      const chunk = observations.slice(
        start,
        start + MAX_OBSERVATIONS_PER_WRITE,
      );
      const saved = await writeObservationBatch(deps.write, {
        projectId: target.projectId,
        serverId: target.serverId,
        contextHash: target.contextHash,
        flushId: randomUUID(),
        observations: chunk,
      });
      if (saved) {
        outcome.writes += 1;
        outcome.observations += chunk.length;
      }
    }
  }
  return outcome;
}
