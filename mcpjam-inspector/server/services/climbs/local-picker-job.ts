/**
 * MCPJam's steps on a person's machine. No worker claims them there, so the
 * Inspector that started the climb runs them itself, as a detached job: it
 * reads the climb, takes the step the backend marked due
 * (`markClimbStepStarted`), runs it under the lease, and reports it finished.
 * It is started by `start_climb` (when MCPJam picks) and by `continue_climb`,
 * and it ends when the climb stops, pauses, or has nothing left to do.
 *
 * Only the running step is registered with the drain, so a shutdown waits for
 * it and not for a job that is idle between rounds. A job that finds the drain
 * begun with a step due takes that step and reports it interrupted, which
 * pauses the climb (`inspector_stopped`) until `continue_climb`. A step cut off
 * by the end of the process pauses it the same way once its lease lapses.
 */
import type { Context } from "hono";
import type { PlatformClimb } from "@mcpjam/sdk/platform";
import { HOSTED_MODE } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { getBackgroundRunBearerForRequest } from "../../utils/v1-convex-token.js";
import { createConvexClient } from "../../routes/v1/convex-client.js";
import { serverDrain } from "../lifecycle/drain.js";
import { climbFns } from "./backend.js";
import { runPickerStep, type StepClaim, type StepLease } from "./picker-step.js";
import type { PickerPorts } from "./picker-ports.js";

/** Where a new climb's steps run. The server decides: a client that could choose could park a step nobody runs. */
export function stepRunnerFor(hosted: boolean = HOSTED_MODE): "hosted" | "local" {
  return hosted ? "hosted" : "local";
}

const POLL_MS = 5_000;
/** Polls in a row that find the climb ready with no step due before the job ends; the backend marks one the moment a round settles. */
const IDLE_POLLS = 24;

type Started = StepClaim & { started: true };

export type LocalJobArgs = {
  projectId: string;
  climbId: string;
  /** Re-resolves the person's bearer for each call, so a long climb is not held to one token. */
  getBearer: () => Promise<string>;
};

export type LocalJobDeps = {
  ports?: PickerPorts;
  pollMs?: number;
  drain?: Pick<typeof serverDrain, "isDraining" | "track">;
};

const running = new Map<string, { stop: () => void; done: Promise<void> }>();

/** Starts the job for a climb unless one already runs. Answers whether it started one. */
export function startLocalPickerJob(args: LocalJobArgs, deps: LocalJobDeps = {}): boolean {
  if (running.has(args.climbId)) return false;
  const abort = new AbortController();
  const done = runJob(args, deps, abort.signal)
    .catch((error: unknown) => {
      // The climb waits: a step that was taken lapses and pauses it, and `continue_climb` starts the job again.
      logger.warn("[climbs] a local picker job ended with an error", {
        climbId: args.climbId,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => running.delete(args.climbId));
  running.set(args.climbId, { stop: () => abort.abort(), done });
  return true;
}

/** Ends every job and waits for them. For tests and shutdown paths that cannot wait for a round. */
export async function stopLocalPickerJobs(): Promise<void> {
  const jobs = [...running.values()];
  for (const job of jobs) job.stop();
  await Promise.all(jobs.map((job) => job.done));
}

/**
 * The routes' entry. The person's bearer is resolved first, so a request that cannot run a job fails before it
 * creates or resumes anything; the function it answers starts the job for a climb.
 */
export async function pickerJobFor(c: Context, projectId: string): Promise<(climbId: string) => void> {
  const getBearer = await getBackgroundRunBearerForRequest(c, projectId);
  return (climbId) => void startLocalPickerJob({ projectId, climbId, getBearer });
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

async function runJob(args: LocalJobArgs, deps: LocalJobDeps, signal: AbortSignal): Promise<void> {
  const { climbId, getBearer } = args;
  const drain = deps.drain ?? serverDrain;
  const convex = async () => createConvexClient(await getBearer());
  let idle = 0;
  while (!signal.aborted) {
    const climb: PlatformClimb = await (await convex()).query(climbFns.get, { climbId });
    // A stopped or paused climb waits for a person; one picked by someone else is not this job's.
    if (climb.state === "stopped" || climb.paused || climb.picker !== "mcpjam" || climb.stepRunner !== "local") return;
    if (climb.step?.status === "due") {
      idle = 0;
      const started: Started = await (await convex()).mutation(climbFns.stepStarted, { climbId });
      if (drain.isDraining()) {
        await (await convex()).mutation(climbFns.stepFinished, { climbId, generation: started.generation, interrupted: true });
        return;
      }
      // A step that failed paused the climb: the job has nothing more to do until `continue_climb`.
      if ((await drain.track("claimed_job", runStep(args, started, deps, signal))) === "ended") return;
      continue;
    }
    idle = climb.state === "ready" && !climb.step ? idle + 1 : 0;
    if (idle > IDLE_POLLS || drain.isDraining()) return;
    await sleep(deps.pollMs ?? POLL_MS, signal);
  }
}

async function runStep(args: LocalJobArgs, started: Started, deps: LocalJobDeps, signal: AbortSignal): Promise<"next" | "ended"> {
  const { climbId, getBearer } = args;
  const { generation } = started;
  const convex = async () => createConvexClient(await getBearer());
  const lease: StepLease = {
    renew: async () => {
      const renewed: { leaseOk: boolean; stop: boolean } = await (await convex()).mutation(climbFns.stepStarted, { climbId, generation });
      return { leaseOk: renewed.leaseOk, stop: renewed.stop };
    },
    spend: async (spend) => {
      await (await convex()).mutation(climbFns.stepSpend, { climbId, generation, ...spend });
    },
  };
  const claim: StepClaim = {
    climbId,
    generation,
    projectId: args.projectId,
    pickerModel: started.pickerModel,
    heartbeatIntervalMs: started.heartbeatIntervalMs,
    resumeRound: started.resumeRound,
  };
  try {
    const result = await runPickerStep(claim, lease, getBearer, { signal, ...(deps.ports ? { ports: deps.ports } : {}) });
    if (result.kind !== "done") return "next";
    // A stop that cut the turn short is the Inspector stopping, not a turn that found nothing to submit.
    const finish = signal.aborted
      ? { interrupted: true }
      : result.submittedRound !== undefined
        ? { submittedRound: result.submittedRound }
        : {};
    await (await convex()).mutation(climbFns.stepFinished, { climbId, generation, ...finish });
    return signal.aborted ? "ended" : "next";
  } catch (error) {
    logger.warn("[climbs] a local picker step failed", { climbId, error: error instanceof Error ? error.message : String(error) });
    // Nothing else can take a local step, so say now that it stopped: the climb pauses and a person decides.
    await (await convex()).mutation(climbFns.stepFinished, { climbId, generation, interrupted: true }).catch((finishError: unknown) => {
      logger.warn("[climbs] a local picker step could not be reported as stopped; its lease will lapse and pause the climb", {
        climbId,
        error: finishError instanceof Error ? finishError.message : String(finishError),
      });
    });
    return "ended";
  }
}
