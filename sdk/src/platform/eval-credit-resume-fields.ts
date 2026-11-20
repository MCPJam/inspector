import {
  parseCreditRecovery,
  type CreditRecovery,
} from "../contract/credit-recovery.js";
import {
  isCreditBlock,
  readEvalRunIncompleteCases,
  replayLaunchResumeInstruction,
  stoppedRunResumeInstruction,
  type EvalResumeInstruction,
  type IncompleteEvalCases,
} from "../eval-credit-resume.js";
import type { PlatformApiClient } from "./client.js";
import { isPlatformApiError } from "./errors.js";

/** The launch a credit refusal's resume replays. */
interface RefusedLaunch {
  projectId: string;
  suiteId: string;
  input: object;
}

/**
 * A failed fan-out target's error, with its credit recovery re-parsed (the
 * wire value is unvalidated) and, when a person must act on it, the call that
 * replays the whole launch under its group key, which launches only the
 * targets that did not start.
 */
export function failedTargetCreditFields(
  error: { code: string; message: string; recovery?: unknown },
  launch: RefusedLaunch
): {
  error: { code: string; message: string; recovery?: CreditRecovery };
  resume?: EvalResumeInstruction;
} {
  const recovery = parseCreditRecovery(error.recovery);
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(recovery ? { recovery } : {}),
    },
    ...(isCreditBlock(recovery)
      ? { resume: replayLaunchResumeInstruction(launch) }
      : {}),
  };
}

/**
 * Run a single-target launch and, when credits refuse it with a step a person
 * must take, put the call that replays it on the thrown error's `details`, the
 * same `resume` a refused fan-out target carries. Every other error is
 * rethrown untouched.
 */
export async function withRefusalResume<T>(
  launch: RefusedLaunch,
  start: () => Promise<T>
): Promise<T> {
  try {
    return await start();
  } catch (error) {
    if (
      isPlatformApiError(error) &&
      error.details &&
      isCreditBlock(parseCreditRecovery(error.details.recovery))
    ) {
      error.details.resume = replayLaunchResumeInstruction(launch);
    }
    throw error;
  }
}

/**
 * True when a launch resumes a stopped run and names no target. The backend
 * then runs it on the source run's own target, which may be a composed or
 * since-detached environment no selector here could name, so target planning
 * is skipped and one run is launched with no target.
 */
export function resumesOnSourceTarget(input: {
  resumeFromRunId?: string;
  servers?: unknown;
  environment?: unknown;
  environments?: unknown;
  host?: unknown;
  hosts?: unknown;
  allAttached?: boolean;
  compose?: unknown;
}): boolean {
  return (
    input.resumeFromRunId !== undefined &&
    input.servers === undefined &&
    input.environment === undefined &&
    input.environments === undefined &&
    input.host === undefined &&
    input.hosts === undefined &&
    input.allAttached !== true &&
    input.compose === undefined
  );
}

/**
 * For a run credits stopped with a step a person must take: the call that
 * resumes it and the cases that call will run. Nothing for any other run.
 */
export async function creditStopResumeFields(
  client: Pick<PlatformApiClient, "listEvalRunIterations">,
  signal: AbortSignal | undefined,
  projectId: string,
  run: { id: string; suiteId: string; resumeSelection?: unknown },
  recovery: CreditRecovery | undefined
): Promise<{
  resume?: EvalResumeInstruction;
  incompleteCases?: IncompleteEvalCases;
}> {
  if (!isCreditBlock(recovery)) return {};
  const incompleteCases = await readEvalRunIncompleteCases(
    client,
    signal,
    projectId,
    run
  );
  return {
    resume: stoppedRunResumeInstruction(projectId, run),
    ...(incompleteCases ? { incompleteCases } : {}),
  };
}
