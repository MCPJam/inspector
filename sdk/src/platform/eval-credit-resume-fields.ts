import {
  parseCreditRecovery,
  type CreditRecovery,
} from "../contract/credit-recovery.js";
import {
  isCreditBlock,
  readEvalRunIncompleteCases,
  refusedTargetResumeInstruction,
  stoppedRunResumeInstruction,
  type EvalResumeInstruction,
  type IncompleteEvalCases,
} from "../eval-credit-resume.js";
import type { PlatformApiClient } from "./client.js";

/**
 * A failed fan-out target's error, with its credit recovery re-parsed (the
 * wire value is unvalidated) and, when a person must act on it, the call that
 * re-launches that one target.
 */
export function failedTargetCreditFields(
  error: { code: string; message: string; recovery?: unknown },
  launch: {
    projectId: string;
    suiteId: string;
    input: object;
    target: { environmentId?: string; hostId?: string };
  }
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
      ? { resume: refusedTargetResumeInstruction(launch, launch.target) }
      : {}),
  };
}

/**
 * For a run credits stopped with a step a person must take: the call that
 * resumes it and the cases that call will run. Nothing for any other run.
 */
export async function creditStopResumeFields(
  client: Pick<PlatformApiClient, "listEvalRunIterations">,
  signal: AbortSignal | undefined,
  projectId: string,
  run: Parameters<typeof stoppedRunResumeInstruction>[1],
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
    run.id
  );
  return {
    resume: stoppedRunResumeInstruction(projectId, run),
    ...(incompleteCases ? { incompleteCases } : {}),
  };
}
