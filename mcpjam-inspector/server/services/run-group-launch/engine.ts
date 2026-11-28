/**
 * The launch engine: one launch of many runs (a run group) from the request
 * to the reply, for any adopter. Swarms are the first.
 *
 *   1. A key seen before is the same launch: it is replayed from its record,
 *      without planning it again.
 *   2. Otherwise the adopter plans it (its ordered items, or a refusal).
 *   3. `begin` writes the record (or replays it) and says whether this call
 *      holds it.
 *   4. The first item starts inside the request, so the commonest refusals
 *      are the call's answer; the reply is 202 once an item started.
 *   5. The rest launch in the background, under the drain (`session.ts`).
 *
 * `resumeRunGroup` claims the caller's own stopped or interrupted launch by
 * its id and continues it from step 4.
 */
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { backendRefusal, generationOf, type LaunchClaim } from "./backend.js";
import type { RunGroupLaunchPorts } from "./ports.js";
import { LaunchSession } from "./session.js";
import type {
  PlannedRunGroup,
  RunGroupLaunchAdapter,
  RunGroupLaunchDeps,
  RunGroupLaunchOutcome,
  RunGroupLaunchRecord,
  RunGroupRefusal,
} from "./types.js";

export function isRunGroupRefusal<P>(
  outcome: RunGroupLaunchOutcome<P>,
): outcome is RunGroupRefusal<P> {
  return "error" in outcome;
}

/** A route error as the engine's refusal, with the record when there is one. */
export function refusalOf<P>(
  error: WebRouteError,
  record?: RunGroupLaunchRecord<P>,
): RunGroupRefusal<P> {
  return {
    status: error.status,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
    ...(record ? { record } : {}),
    ...(error.headers ? { headers: error.headers } : {}),
  };
}

/** A structured backend refusal as a reply; anything else is rethrown. */
function refusalOrThrow<P>(error: unknown): RunGroupRefusal<P> {
  const refused = backendRefusal(error);
  if (refused) return refusalOf(refused);
  throw error;
}

interface EngineCall<P> {
  adapter: RunGroupLaunchAdapter<P>;
  projectId: string;
  deps: RunGroupLaunchDeps;
  ports: RunGroupLaunchPorts<P>;
}

export async function launchRunGroup<P>(
  call: EngineCall<P> & {
    idempotencyKey?: string;
    /** What the record fingerprints: what is launched, not how it was asked. */
    request: Record<string, unknown>;
    /** A new launch's items; not called when the key replays a recorded one. */
    plan: () => Promise<PlannedRunGroup<P> | RunGroupRefusal<P>>;
  },
): Promise<RunGroupLaunchOutcome<P>> {
  const { adapter, projectId, idempotencyKey: key, request } = call;
  const backend = call.ports.backend(call.deps.bearerToken);
  const scope = { kind: adapter.kind, projectId };
  let planned: PlannedRunGroup<P> | RunGroupRefusal<P> | null = null;
  if (key) {
    let recorded: RunGroupLaunchRecord<P> | null;
    try {
      recorded = await backend.getByKey({ ...scope, idempotencyKey: key });
    } catch (error) {
      return refusalOrThrow(error);
    }
    if (recorded) {
      // A replay launches the record's own items; `begin` checks the request
      // against the record's fingerprint.
      planned = {
        items: recorded.items.map(({ itemKey, params }) => ({
          itemKey,
          params,
        })),
        ...(recorded.swarmId ? { swarmId: recorded.swarmId } : {}),
        ...(recorded.sourceRunGroupId
          ? { sourceRunGroupId: recorded.sourceRunGroupId }
          : {}),
      };
    }
  }
  planned ??= await call.plan();
  if ("error" in planned) return planned;
  const { items, swarmId, sourceRunGroupId } = planned;
  return runClaimed(call, () =>
    backend.begin({
      ...scope,
      ...(swarmId ? { swarmId } : {}),
      ...(sourceRunGroupId ? { sourceRunGroupId } : {}),
      ...(key ? { idempotencyKey: key } : {}),
      request,
      items,
    }),
  );
}

export async function resumeRunGroup<P>(
  call: EngineCall<P> & { runGroupId: string },
): Promise<RunGroupLaunchOutcome<P>> {
  const { adapter, projectId, runGroupId } = call;
  return runClaimed(call, () =>
    call.ports
      .backend(call.deps.bearerToken)
      .resume({ kind: adapter.kind, projectId, runGroupId }),
  );
}

/** Steps 3 to 5, for a new launch, a replayed one and a resumed one. */
async function runClaimed<P>(
  call: EngineCall<P>,
  claimRecord: () => Promise<LaunchClaim<P>>,
): Promise<RunGroupLaunchOutcome<P>> {
  let claim: LaunchClaim<P>;
  try {
    claim = await claimRecord();
  } catch (error) {
    return refusalOrThrow(error);
  }
  // Running elsewhere, or ended: answer with the record as it stands.
  if (!claim.claimed) return { status: 202, record: claim.record };

  const session = new LaunchSession(
    call.projectId,
    claim.record,
    generationOf(claim),
    call.adapter,
    call.deps,
    call.ports,
  );
  session.startHeartbeat();
  const first = await session.startFirst();
  if (first.kind === "started") {
    const record = session.record.snapshot();
    session.continueInBackground(first.rest);
    return { status: 202, record };
  }
  if (first.kind === "lost") {
    return { status: 202, record: session.record.snapshot() };
  }
  if (first.kind === "stop") {
    await session.finish("stopped", first.error, first.retryAfterAt);
    if (first.cause instanceof WebRouteError) {
      return refusalOf(first.cause, session.record.snapshot());
    }
    throw first.cause;
  }

  // No item is left to start, and none started in this call.
  await session.finish(session.record.settledState());
  const record = session.record.snapshot();
  if (session.record.anyStarted()) return { status: 202, record };
  return refusalOf(
    first.firstFailure instanceof WebRouteError
      ? first.firstFailure
      : new WebRouteError(
          422,
          ErrorCode.VALIDATION_ERROR,
          "None of this launch's runs could start. Check them, then launch again.",
        ),
    record,
  );
}
