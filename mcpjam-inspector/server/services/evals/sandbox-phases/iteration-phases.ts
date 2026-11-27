/**
 * The three things a run's code evaluators and scripts do inside one
 * iteration (EFTW-90), in order: setup before the agent's first turn, grading
 * after the agent's box is gone, and cleanup after grading.
 *
 * - **Setup** runs in the agent's box when the iteration has one, so the
 *   agent sees what it created; otherwise in a box of its own. A failure (a
 *   non-zero exit, the 5-minute limit) means the agent never runs and the
 *   iteration is Setup failed. It is never retried: a script bug fails every
 *   retry.
 * - **Grading** boots a fresh box from the run's image, with no network
 *   unless the suite allows it, writes `/mcpjam/iteration.json` and runs every
 *   evaluator at the same time, each with its own 60-second limit. A lost box
 *   is retried once on a fresh one; anything an evaluator does wrong is an
 *   error row with its output, never a failed iteration.
 * - **Cleanup** gets its own box and 2 minutes. A failure is a warning.
 *
 * Every limit is also bounded by what is left of the iteration's clock
 * (amendment P4), so a phase can't outlive the iteration it belongs to.
 */
import type { EvaluatorContextV1 } from "@mcpjam/sdk/contract";
import { CommandExitError } from "e2b";
import {
  runPhaseScript,
  lastOutputLine,
  type PhaseRunResult,
  type PhaseSandbox,
} from "./exec.js";
import type {
  FrozenCodeEvaluator,
  FrozenCodeGrading,
} from "./frozen-config.js";
import { withPhaseBox, type PhaseBoxDeps } from "./phase-box.js";
import {
  restoreGradingFiles,
  type CollectedGradingFiles,
} from "./grading-files.js";
import type {
  CodeEvaluatorOutcome,
  CodeGradingResult,
} from "./code-score-family.js";

export const PHASE_LIMITS_MS = {
  setup: 5 * 60_000,
  cleanup: 2 * 60_000,
  evaluator: 60_000,
  /** How long a phase box may wait for capacity. */
  capacity: 2 * 60_000,
  /** Packing and reading the declared files in the agent's box. */
  collect: 60_000,
};

const GRADING_ROOT = "/mcpjam";
const SCRIPT_DIR = "/tmp/mcpjam";
const WORKDIR = "/home/user";

export type IterationPhaseContext = {
  config: FrozenCodeGrading;
  runId: string;
  iterationId: string;
  caseId?: string;
  /** A fresh bearer per call: a long iteration renews it. */
  bearer: () => string;
  /** When the iteration's own clock runs out (epoch ms). */
  deadlineAt: number;
  signal?: AbortSignal;
  /** Set once cleanup has run: it runs at most once per iteration. */
  cleanedUp?: boolean;
  /** Tests only. */
  deps?: PhaseBoxDeps;
};

/** A setup or cleanup script's outcome, as the iteration's metadata keeps it. */
export type IterationScriptResult = {
  status: "passed" | "failed" | "timeout" | "error";
  exitCode?: number;
  output: string;
  durationMs: number;
  error?: string;
};

function remaining(ctx: IterationPhaseContext, limit: number): number {
  return Math.max(0, Math.min(limit, ctx.deadlineAt - Date.now()));
}

function phaseEnv(
  ctx: IterationPhaseContext,
  phase: string,
): Record<string, string> {
  return {
    MCPJAM_RUN_ID: ctx.runId,
    MCPJAM_ITERATION_ID: ctx.iterationId,
    ...(ctx.caseId ? { MCPJAM_CASE_ID: ctx.caseId } : {}),
    MCPJAM_PHASE: phase,
  };
}

function scriptResult(run: PhaseRunResult): IterationScriptResult {
  return {
    status:
      run.status === "exited"
        ? run.exitCode === 0
          ? "passed"
          : "failed"
        : run.status,
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    output: run.output,
    durationMs: run.durationMs,
    ...(run.error ? { error: run.error } : {}),
  };
}

async function runScript(
  ctx: IterationPhaseContext,
  sandbox: PhaseSandbox,
  phase: "iteration_setup" | "iteration_cleanup",
  script: string,
  limitMs: number,
): Promise<IterationScriptResult> {
  return scriptResult(
    await runPhaseScript({
      sandbox,
      scriptPath: `${SCRIPT_DIR}/${phase}.sh`,
      script,
      fileName: `${phase}.sh`,
      env: phaseEnv(ctx, phase),
      cwd: WORKDIR,
      timeoutMs: remaining(ctx, limitMs),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
  );
}

/**
 * Run the iteration setup script, in `agentBox` when the iteration has one.
 * `undefined` when the suite has none.
 */
export async function runIterationSetup(
  ctx: IterationPhaseContext,
  agentBox: PhaseSandbox | undefined,
): Promise<IterationScriptResult | undefined> {
  const script = ctx.config.scripts.iterationSetup;
  if (!script) return undefined;
  if (agentBox) {
    return await runScript(
      ctx,
      agentBox,
      "iteration_setup",
      script,
      PHASE_LIMITS_MS.setup,
    );
  }
  const boxed = await withPhaseBox(
    {
      runId: ctx.runId,
      iterationId: ctx.iterationId,
      phase: "iteration_setup",
      bearer: ctx.bearer(),
      timeoutMs: remaining(ctx, PHASE_LIMITS_MS.capacity),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
    (sandbox) =>
      runScript(ctx, sandbox, "iteration_setup", script, PHASE_LIMITS_MS.setup),
    ctx.deps,
  );
  return boxed.ok
    ? boxed.value
    : { status: "error", output: "", durationMs: 0, error: boxed.error };
}

/** The message an iteration whose setup failed carries. */
export function describeSetupFailure(result: IterationScriptResult): string {
  const why =
    result.status === "timeout"
      ? "was stopped at its time limit"
      : result.status === "error"
        ? `couldn't run: ${result.error ?? "unknown error"}`
        : `exited with code ${result.exitCode}`;
  const line = lastOutputLine(result.output);
  return `The iteration setup script ${why}, so the agent didn't run.${line ? ` Last output: ${line}` : ""}`;
}

/** Run the iteration cleanup script in a box of its own. Never throws. */
export async function runIterationCleanup(
  ctx: IterationPhaseContext,
): Promise<IterationScriptResult | undefined> {
  const script = ctx.config.scripts.iterationCleanup;
  if (!script) return undefined;
  // Its own clock and no signal: cleanup also runs after a cancel or a
  // timeout, when the iteration's clock has run out and its signal fired.
  const { signal: _iterationSignal, ...rest } = ctx;
  const cleanupCtx = {
    ...rest,
    deadlineAt: Date.now() + PHASE_LIMITS_MS.capacity + PHASE_LIMITS_MS.cleanup,
  };
  const boxed = await withPhaseBox(
    {
      runId: ctx.runId,
      iterationId: ctx.iterationId,
      phase: "iteration_cleanup",
      bearer: ctx.bearer(),
      timeoutMs: PHASE_LIMITS_MS.capacity,
    },
    (sandbox) =>
      runScript(
        cleanupCtx,
        sandbox,
        "iteration_cleanup",
        script,
        PHASE_LIMITS_MS.cleanup,
      ),
    ctx.deps,
  );
  return boxed.ok
    ? boxed.value
    : { status: "error", output: "", durationMs: 0, error: boxed.error };
}

/** Parse an evaluator's result file into a score, or say what is wrong with it. */
export function parseEvaluatorResult(
  raw: string,
): { score: number; reason?: string } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { problem: "Its result file isn't valid JSON." };
  }
  const result = (parsed ?? {}) as { score?: unknown; reason?: unknown };
  if (
    typeof result.score !== "number" ||
    !Number.isFinite(result.score) ||
    result.score < 0 ||
    result.score > 1
  ) {
    return { problem: 'Its result needs a "score" from 0 to 1.' };
  }
  return {
    score: result.score,
    ...(typeof result.reason === "string" && result.reason.trim()
      ? { reason: result.reason.trim().slice(0, 2000) }
      : {}),
  };
}

async function runEvaluator(
  ctx: IterationPhaseContext,
  sandbox: PhaseSandbox,
  evaluator: FrozenCodeEvaluator,
): Promise<CodeEvaluatorOutcome> {
  const resultPath = `${GRADING_ROOT}/results/${evaluator.id}.json`;
  const run = await runPhaseScript({
    sandbox,
    scriptPath: `${GRADING_ROOT}/evaluators/${evaluator.id}/${evaluator.fileName}`,
    script: evaluator.script,
    fileName: evaluator.fileName,
    env: {
      ...phaseEnv(ctx, "grading"),
      MCPJAM_ITERATION: `${GRADING_ROOT}/iteration.json`,
      MCPJAM_RESULT: resultPath,
    },
    cwd: WORKDIR,
    timeoutMs: remaining(ctx, PHASE_LIMITS_MS.evaluator),
    cleanHome: `/tmp/mcpjam-home/${evaluator.id}`,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const base = {
    output: run.output,
    durationMs: run.durationMs,
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
  };
  if (run.status === "timeout") {
    return { kind: "error", error: "Stopped at its time limit.", ...base };
  }
  if (run.status === "error") {
    return { kind: "error", error: `Couldn't run: ${run.error}`, ...base };
  }
  if (run.exitCode !== 0) {
    return {
      kind: "error",
      error: `Exited with code ${run.exitCode}.`,
      ...base,
    };
  }
  let raw: string;
  try {
    raw = await sandbox.files.read(resultPath);
  } catch {
    return {
      kind: "error",
      error: "It finished without writing a result to $MCPJAM_RESULT.",
      ...base,
    };
  }
  const parsed = parseEvaluatorResult(raw);
  if ("problem" in parsed)
    return { kind: "error", error: parsed.problem, ...base };
  return { kind: "scored", ...parsed, ...base, exitCode: 0 };
}

/** Make `/mcpjam` the box user's, then write the input every evaluator reads. */
async function prepareGradingBox(
  sandbox: PhaseSandbox,
  input: EvaluatorContextV1,
): Promise<void> {
  try {
    await sandbox.commands.run(
      `mkdir -p ${GRADING_ROOT}/results ${GRADING_ROOT}/evaluators && chown -R user:user ${GRADING_ROOT}`,
      { user: "root", timeoutMs: 30_000 },
    );
  } catch (error) {
    if (error instanceof CommandExitError) {
      throw new Error(`Could not prepare the grading box: ${error.message}`);
    }
    throw error;
  }
  await sandbox.files.write(
    `${GRADING_ROOT}/iteration.json`,
    JSON.stringify(input),
  );
}

/**
 * Grade one iteration: every frozen evaluator against `input`, at the same
 * time, in one grading box. A box that can't be had, or is lost twice, errors
 * every evaluator with the reason.
 */
export async function gradeIteration(
  ctx: IterationPhaseContext,
  input: EvaluatorContextV1,
  files?: CollectedGradingFiles,
): Promise<CodeGradingResult> {
  const evaluators = ctx.config.codeEvaluators;
  if (evaluators.length === 0) return { evaluators, outcomes: {} };
  // Grading without the files would score a workspace the agent didn't leave.
  if (files && !files.ok) return erroredGrading(evaluators, files.problem);
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const boxed = await withPhaseBox(
      {
        runId: ctx.runId,
        iterationId: ctx.iterationId,
        phase: "grading",
        ...(attempt > 1 ? { attempt } : {}),
        bearer: ctx.bearer(),
        timeoutMs: remaining(ctx, PHASE_LIMITS_MS.capacity),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
      async (sandbox) => {
        // Restored before `/mcpjam` exists, as the agent's files are inputs.
        if (files?.ok) await restoreGradingFiles(sandbox, files.entries);
        await prepareGradingBox(sandbox, input);
        const outcomes = await Promise.all(
          evaluators.map((evaluator) => runEvaluator(ctx, sandbox, evaluator)),
        );
        return Object.fromEntries(
          evaluators.map((evaluator, index) => [evaluator.id, outcomes[index]]),
        );
      },
      ctx.deps,
    );
    if (boxed.ok) return { evaluators, outcomes: boxed.value };
    lastError = boxed.error;
    // Only a box that went away mid-grading is worth a fresh one: grading has
    // no side effects. A box the control plane refused will be refused again.
    if (boxed.reason !== "lost") break;
  }
  return erroredGrading(evaluators, `The grading box failed: ${lastError}`);
}

/** Every evaluator errored for the same reason. */
function erroredGrading(
  evaluators: readonly FrozenCodeEvaluator[],
  error: string,
): CodeGradingResult {
  return {
    evaluators,
    outcomes: Object.fromEntries(
      evaluators.map((evaluator) => [
        evaluator.id,
        { kind: "error" as const, error, output: "" },
      ]),
    ),
  };
}
