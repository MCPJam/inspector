/**
 * The runner's three calls into an iteration's phases (EFTW-90): build the
 * context, run setup before the first turn, and grade and clean up after the
 * agent's box is gone. Kept out of `evals-runner.ts`, which may grow only 50
 * lines a change, so the runner holds no phase logic of its own.
 */
import type { EvaluatorContextV1 } from "@mcpjam/sdk/contract";
import { attachRunningSandbox } from "../../../utils/computers/attach-sandbox.js";
import type { CodeGradingResult } from "./code-score-family.js";
import { hasIterationPhases, type FrozenCodeGrading } from "./frozen-config.js";
import {
  describeSetupFailure,
  gradeIteration,
  runIterationCleanup,
  runIterationSetup,
  type IterationPhaseContext,
  type IterationScriptResult,
} from "./iteration-phases.js";

/**
 * The phase context for one hosted iteration, or `undefined` when its run
 * froze no iteration phases or the iteration has no run (a quick run).
 */
export function iterationPhaseContext(args: {
  config: FrozenCodeGrading | undefined;
  runId: string | null | undefined;
  iterationId: string | undefined;
  caseId?: string;
  bearer: () => string;
  deadlineAt: number;
  signal?: AbortSignal;
}): IterationPhaseContext | undefined {
  if (!args.config || !args.runId || !args.iterationId) return undefined;
  if (!hasIterationPhases(args.config)) return undefined;
  return {
    config: args.config,
    runId: String(args.runId),
    iterationId: String(args.iterationId),
    ...(args.caseId ? { caseId: args.caseId } : {}),
    bearer: args.bearer,
    deadlineAt: args.deadlineAt,
    ...(args.signal ? { signal: args.signal } : {}),
  };
}

type ScriptsMetadata = {
  iterationScripts?: {
    setup?: IterationScriptResult;
    cleanup?: IterationScriptResult;
  };
};

/**
 * Run iteration setup and record its result in `metadata`; throw the
 * Setup failed message when it didn't pass, so the runner's setup catch
 * records the iteration as it records any other setup failure.
 */
export async function runIterationSetupOrThrow(
  ctx: IterationPhaseContext | undefined,
  agentSandboxId: string | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!ctx?.config.scripts.iterationSetup) return;
  const agentBox = agentSandboxId
    ? await attachRunningSandbox(agentSandboxId)
    : undefined;
  const setup = await runIterationSetup(ctx, agentBox);
  if (!setup) return;
  const scripts = (metadata as ScriptsMetadata).iterationScripts ?? {};
  metadata.iterationScripts = { ...scripts, setup };
  if (setup.status !== "passed") throw new Error(describeSetupFailure(setup));
}

/** Run iteration cleanup and record its result in `metadata`. Never throws. */
export async function runIterationCleanupInto(
  ctx: IterationPhaseContext | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!ctx) return;
  const cleanup = await runIterationCleanup(ctx);
  if (!cleanup) return;
  const scripts = (metadata as ScriptsMetadata).iterationScripts ?? {};
  metadata.iterationScripts = { ...scripts, cleanup };
}

/**
 * After the agent's box is gone: grade when the agent finished, then clean
 * up. The result declares every frozen evaluator, graded or not, so each
 * iteration of a case carries the same score definitions.
 */
export async function finishIterationPhases(
  ctx: IterationPhaseContext | undefined,
  args: {
    /** Why grading doesn't run (the agent failed, the server never came up). */
    notRun?: string;
    input: () => EvaluatorContextV1;
  },
  metadata: Record<string, unknown>,
): Promise<CodeGradingResult | undefined> {
  if (!ctx) return undefined;
  const evaluators = ctx.config.codeEvaluators;
  const result: CodeGradingResult | undefined =
    evaluators.length === 0
      ? undefined
      : args.notRun
        ? { evaluators, outcomes: {}, notRun: args.notRun }
        : await gradeIteration(ctx, args.input());
  await runIterationCleanupInto(ctx, metadata);
  return result;
}
