/**
 * climb-worker.ts: the claim loop for MCPJam's steps on a climb it picks for.
 *
 * Same pull architecture as the scheduled and production loops: the backend
 * marks a step due (the baseline settled, a round settled, `continue_climb`),
 * this loop claims it over the service-token routes
 * (`/internal/v1/climbs/steps/*`), acts as the person who started the climb
 * (`getConvexBearerForDelegation`, re-minted per call so a long climb is not
 * held to one token), runs the step (`runPickerStep`, the function a person's
 * own Inspector runs as a local job), and releases the lease with the round it
 * submitted. The backend never calls the Inspector.
 *
 * The lease is 90 s and renewed by heartbeat every 20 s; a heartbeat answered
 * "lost" ends the step and writes nothing, since the backend refuses it. A step
 * that throws is left to the backend's sweep, which offers it again up to three
 * times and then pauses the climb with the reason. The round's runs are
 * launched by the step's own call to the round route, in this process, and are
 * tracked by the drain like any run; a step cut off after it registered its
 * round is claimed again with `resumeRound`, and launches the same groups.
 *
 * ONE switch, and it is the backend's `climbs` flag. There is no flag of its
 * own here and no environment variable: a deployment without the service
 * credential is not a worker peer and never starts the loop (it is inert, as
 * production scoring is), and a backend with the routes off answers 404, which
 * parks the loop on a slow poll.
 */
import { logger } from "../utils/logger.js";
import { getConvexBearerForDelegation } from "../utils/v1-convex-token.js";
import { serverDrain } from "./lifecycle/drain.js";
import { getServiceCredential } from "./service-credential.js";
import { runPickerStep, type StepClaim, type StepLease, type StepResult } from "./climbs/picker-step.js";

const POLL_JITTER_MS = 1_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
/** Backoff after claim/transport errors so a broken backend isn't hammered. */
const ERROR_BACKOFF_MS = 60_000;
/** Per-request cap so a stalled Convex can't wedge a step. */
const SERVICE_ROUTE_TIMEOUT_MS = 15_000;
const BASE = "/internal/v1/climbs/steps";

/** What `POST /claim` answers for a step it handed out. */
export type ClaimedClimbStep = StepClaim & {
  organizationId?: string;
  actAs: { userId: string; externalId: string; email?: string };
};

type ClaimOutcome = { kind: "claimed"; claim: ClaimedClimbStep } | { kind: "empty"; retryAfterMs: number } | { kind: "disabled" };
type Post = (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, any> | null }>;

function requiredEnv(): { convexUrl: string; serviceToken: string } | null {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = getServiceCredential();
  return convexUrl && serviceToken ? { convexUrl, serviceToken } : null;
}

const postServiceRoute: Post = async (path, body) => {
  const env = requiredEnv();
  if (!env) throw new Error("The climb worker requires CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN");
  const response = await fetch(`${env.convexUrl}${BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-inspector-service-token": env.serviceToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SERVICE_ROUTE_TIMEOUT_MS),
  });
  let parsed: Record<string, any> | null = null;
  try {
    parsed = (await response.json()) as Record<string, any>;
  } catch {
    // tolerated; the status carries the signal
  }
  return { status: response.status, body: parsed };
};

async function claimNext(post: Post, claimedBy: string): Promise<ClaimOutcome> {
  const { status, body } = await post("claim", { claimedBy });
  // 404: this backend has not got the routes, or has the feature off. Flipping it needs no restart.
  if (status === 404) return { kind: "disabled" };
  if (status !== 200 || !body?.ok) throw new Error(`claim failed (${status}): ${JSON.stringify(body)}`);
  if (body.claimed !== true) return { kind: "empty", retryAfterMs: typeof body.retryAfterMs === "number" ? body.retryAfterMs : DEFAULT_RETRY_AFTER_MS };
  const resume = body.resumeRound;
  if (
    typeof body.climbId !== "string" ||
    typeof body.generation !== "number" ||
    typeof body.projectId !== "string" ||
    typeof body.pickerModel !== "string" ||
    typeof body.actAs?.externalId !== "string"
  ) {
    throw new Error("claim returned a malformed payload");
  }
  return {
    kind: "claimed",
    claim: {
      climbId: body.climbId,
      generation: body.generation,
      projectId: body.projectId,
      pickerModel: body.pickerModel,
      heartbeatIntervalMs: typeof body.heartbeatIntervalMs === "number" ? body.heartbeatIntervalMs : 20_000,
      resumeRound: resume && typeof resume === "object" ? resume : null,
      ...(typeof body.organizationId === "string" ? { organizationId: body.organizationId } : {}),
      actAs: body.actAs,
    },
  };
}

/** The lease a hosted step holds, through the service routes. A lost lease is an answer, not an error. */
function hostedLease(post: Post, claim: ClaimedClimbStep): StepLease {
  const { climbId, generation } = claim;
  return {
    renew: async () => {
      const { status, body } = await post("heartbeat", { climbId, generation });
      if (status === 409) return { leaseOk: false, stop: false };
      if (status !== 200 || !body?.ok) throw new Error(`heartbeat failed (${status})`);
      return { leaseOk: body.leaseOk === true, stop: body.stop === true };
    },
    spend: async ({ estimatedCostUsd, tokens }) => {
      const { status, body } = await post("spend", { climbId, generation, estimatedCostUsd, tokens });
      if (status !== 200 || !body?.ok) throw new Error(`spend was refused (${status}): ${body?.error ?? "no answer"}`);
    },
  };
}

export type ClimbStepRunner = (claim: StepClaim, lease: StepLease, getBearer: () => Promise<string>) => Promise<StepResult>;

/** Executes one claimed step end to end and releases it. Never throws. */
export async function executeClaimedStep(
  claim: ClaimedClimbStep,
  options: { post?: Post; run?: ClimbStepRunner; getBearer?: typeof getConvexBearerForDelegation } = {},
): Promise<void> {
  const post = options.post ?? postServiceRoute;
  const run = options.run ?? runPickerStep;
  const context = { climbId: claim.climbId, generation: claim.generation };
  if (!claim.organizationId) {
    // Acting as the starter needs the organization; without it the lease lapses and the backend offers the step again.
    logger.warn("[climb-worker] a claimed step names no organization, so it cannot act as the person who started the climb", context);
    return;
  }
  const { organizationId, actAs } = claim;
  const getBearer = () => (options.getBearer ?? getConvexBearerForDelegation)(actAs.externalId, organizationId);
  try {
    const result = await run(claim, hostedLease(post, claim), getBearer);
    // A lost lease or a stopped climb has nothing to release: the backend refuses it, or already dropped the step.
    if (result.kind !== "done") return;
    const { status, body } = await post("release", {
      ...context,
      ...(result.submittedRound !== undefined ? { submittedRound: result.submittedRound } : {}),
    });
    if (status === 409) logger.warn("[climb-worker] a step's lease was gone when it was released", context);
    else if (status !== 200 || !body?.ok) logger.warn("[climb-worker] a step could not be released; its lease will lapse", { ...context, status });
  } catch (error) {
    // Left to the backend's sweep: it offers the step again, and pauses the climb after the third attempt.
    logger.warn("[climb-worker] a step failed", { ...context, error: error instanceof Error ? error.message : String(error) });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

export interface ClimbWorkerHandle {
  /** Aborts polling and resolves once the loop (and a step in flight) settles. */
  stop: () => Promise<void>;
}

/**
 * Starts the polling loop. Called unconditionally from `startBackgroundWorkers`;
 * a process with no service credential gets an inert handle. One step in flight
 * per instance: several instances race safely, since the claim is atomic.
 */
export function startClimbWorker(options?: {
  claimedBy?: string;
  post?: Post;
  /** Test seams: override the claim and the execution. */
  claim?: (claimedBy: string) => Promise<ClaimOutcome>;
  execute?: (claim: ClaimedClimbStep) => Promise<void>;
  pollJitterMs?: number;
}): ClimbWorkerHandle {
  if (!requiredEnv() && !options?.post) return { stop: async () => {} };
  const abort = new AbortController();
  const post = options?.post ?? postServiceRoute;
  const claimedBy = options?.claimedBy ?? `inspector-${process.env.RAILWAY_REPLICA_ID ?? process.pid}`;
  const claim = options?.claim ?? ((by: string) => claimNext(post, by));
  const execute = options?.execute ?? ((step: ClaimedClimbStep) => executeClaimedStep(step, { post }));
  logger.info("[climb-worker] started", { claimedBy });

  const loop = (async () => {
    while (!abort.signal.aborted) {
      let waitMs = DEFAULT_RETRY_AFTER_MS;
      try {
        const outcome = await claim(claimedBy);
        if (outcome.kind === "disabled") waitMs = ERROR_BACKOFF_MS;
        else if (outcome.kind === "empty") waitMs = outcome.retryAfterMs;
        else {
          await serverDrain.track("claimed_job", execute(outcome.claim));
          // A round settling marks the next step due: look again at once.
          waitMs = 250;
        }
      } catch (error) {
        logger.warn("[climb-worker] poll failed", { error: error instanceof Error ? error.message : String(error) });
        waitMs = ERROR_BACKOFF_MS;
      }
      await sleep(waitMs + Math.floor(Math.random() * (options?.pollJitterMs ?? POLL_JITTER_MS)), abort.signal);
    }
    logger.info("[climb-worker] stopped");
  })();

  return {
    stop: async () => {
      abort.abort();
      // Bounded by the caller's shutdown force-exit timer; a step that outlasts it is the sweep's.
      await loop;
    },
  };
}
