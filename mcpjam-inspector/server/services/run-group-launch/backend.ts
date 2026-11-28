/**
 * The backend's run-group launch record (`runGroupLaunches:*`), reached
 * through `createConvexClient` with its function names. Every call names the
 * record's kind.
 *
 * A backend is bound to one bearer. The engine asks for a new one per call
 * once it has replied, because the request's own token can expire while the
 * launch is still running.
 *
 * Writes carry the record's generation. Stopping a launch, or resuming it,
 * moves the generation on, and the writers then refuse the old one with
 * `LEASE_LOST`: whoever held it stops quietly.
 */
import { makeFunctionReference } from "convex/server";
import { createConvexClient } from "../evals/route-helpers.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import {
  convexErrorData,
  translateStructuredConvexRefusal,
} from "../../routes/v1/convex-errors.js";
import { showableReason } from "../sessionSimulation/launch-journey-run.js";
import type {
  LaunchError,
  LaunchItemStatus,
  LaunchState,
} from "../../../shared/run-group-launch.js";
import type { LaunchKind, PlannedItem, RunGroupLaunchRecord } from "./types.js";

type Scope = { kind: LaunchKind; projectId: string };
type RecordWrite = Scope & { runGroupId: string; generation: number };

export type BeginArgs<P> = Scope & {
  swarmId?: string;
  sourceRunGroupId?: string;
  idempotencyKey?: string;
  /** What the record fingerprints, so a reused key with another request is refused. */
  request: Record<string, unknown>;
  items: PlannedItem<P>[];
};

/** A launch record, and whether this caller now holds it. */
export type LaunchClaim<P> = {
  record: RunGroupLaunchRecord<P>;
  /** This caller holds the record and launches its pending items. */
  claimed: boolean;
  generation?: number;
};

export type RecordItemArgs = RecordWrite & {
  itemKey: string;
  status: Exclude<LaunchItemStatus, "pending">;
  runId?: string;
  deduped?: boolean;
  error?: LaunchError;
  reason?: string;
};

export type FinishArgs = RecordWrite & {
  state: Extract<LaunchState, "launched" | "partial" | "stopped" | "failed">;
  stopReason?: LaunchError;
  retryAfterAt?: number;
};

export interface RunGroupLaunchBackend<P> {
  /** The caller's own launch of this kind for a key in this project, or null. */
  getByKey(
    args: Scope & { idempotencyKey: string },
  ): Promise<RunGroupLaunchRecord<P> | null>;
  begin(args: BeginArgs<P>): Promise<LaunchClaim<P> & { replayed: boolean }>;
  /** Claims the caller's own stopped or interrupted launch to finish it. */
  resume(args: Scope & { runGroupId: string }): Promise<LaunchClaim<P>>;
  recordItem(args: RecordItemArgs): Promise<void>;
  heartbeat(args: RecordWrite): Promise<void>;
  finish(args: FinishArgs): Promise<void>;
}

type Ok = { ok: true };

/** The backend reached as `bearer`, with a client per call. */
export function convexRunGroupLaunchBackend<P>(
  bearer: string,
): RunGroupLaunchBackend<P> {
  const client = () => createConvexClient(bearer);
  const mutation = <A extends Record<string, unknown>, R>(name: string) =>
    makeFunctionReference<"mutation", A, R>(`runGroupLaunches:${name}`);
  return {
    getByKey: (args) =>
      client().query(
        makeFunctionReference<
          "query",
          Scope & { idempotencyKey: string },
          RunGroupLaunchRecord<P> | null
        >("runGroupLaunches:getByKey"),
        args,
      ),
    begin: (args) =>
      client().mutation(
        mutation<BeginArgs<P>, LaunchClaim<P> & { replayed: boolean }>("begin"),
        args,
      ),
    resume: (args) =>
      client().mutation(
        mutation<Scope & { runGroupId: string }, LaunchClaim<P>>("resume"),
        args,
      ),
    recordItem: async (args) => {
      await client().mutation(mutation<RecordItemArgs, Ok>("recordItem"), args);
    },
    heartbeat: async (args) => {
      await client().mutation(mutation<RecordWrite, Ok>("heartbeat"), args);
    },
    finish: async (args) => {
      await client().mutation(mutation<FinishArgs, Ok>("finish"), args);
    },
  };
}

/** The generation a write must carry, wherever the claim put it. */
export function generationOf<P>(claim: LaunchClaim<P>): number {
  const generation = claim.generation ?? claim.record.generation;
  if (typeof generation !== "number") {
    throw new Error("The launch record came back without a generation.");
  }
  return generation;
}

/** A write refused because the launch was stopped or resumed elsewhere. */
export function isLeaseLost(error: unknown): boolean {
  return convexErrorData(error)?.code === "LEASE_LOST";
}

/** `begin`'s refusal of a key already used for a different request. */
export const IDEMPOTENCY_KEY_REUSED_CODE = "IDEMPOTENCY_KEY_REUSED";

/**
 * The answer for a structured refusal from a read or `begin`/`resume`, or
 * null for a failure the caller should rethrow. The backend's own sentence is
 * kept when it is fit to show.
 */
export function backendRefusal(error: unknown): WebRouteError | null {
  const data = convexErrorData(error);
  const code = typeof data?.code === "string" ? data.code : undefined;
  const message = showableReason(data?.message);
  if (code === "not_found") {
    return new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      message ??
        "That launch was not found in this project. Check the id and try again.",
      { code },
    );
  }
  if (code === IDEMPOTENCY_KEY_REUSED_CODE) {
    return new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      message ??
        "This idempotency key was already used for a different launch. Send the original request again, or use a new key.",
      { code },
    );
  }
  return translateStructuredConvexRefusal(error) ?? null;
}
