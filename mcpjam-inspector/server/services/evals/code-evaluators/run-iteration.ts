/**
 * Runs a trial's code evaluators and gathers their outcomes. Never throws:
 * a missing runner, bad source or failed sandbox is an error outcome.
 */
import { canonicalDigest } from "@mcpjam/sdk/contract";
import { prepareSource } from "./harness.js";
import { codeEvaluatorRunnerFor } from "./runner-registry.js";
import type {
  CodeEvaluatorDefinition,
  CodeEvaluatorOutcome,
  CodeEvaluatorRunner,
} from "./types.js";

export const NO_CODE_RUNNER_REASON =
  "Code evaluators need a sandbox, and this server has none configured.";

export async function runTrialCodeEvaluators(args: {
  evaluators: readonly CodeEvaluatorDefinition[] | undefined;
  /** The run data `evaluate(run)` receives, as plain JSON. */
  run: unknown;
  runKey: string;
  runner?: CodeEvaluatorRunner | null;
}): Promise<CodeEvaluatorOutcome[]> {
  const evaluators = args.evaluators ?? [];
  if (evaluators.length === 0) return [];
  const runner =
    args.runner !== undefined ? args.runner : codeEvaluatorRunnerFor(args.runKey);
  const runJson = JSON.stringify(args.run ?? {});
  const outcomes: CodeEvaluatorOutcome[] = [];
  for (const e of evaluators) {
    const head = {
      id: e.id,
      label: e.label,
      role: e.role,
      sourceDigest: canonicalDigest({ source: e.source }),
    };
    if (!runner) {
      outcomes.push({ ...head, status: "error", reason: NO_CODE_RUNNER_REASON });
      continue;
    }
    const prepared = prepareSource(e.source);
    if (!prepared.ok) {
      outcomes.push({ ...head, status: "error", reason: prepared.reason });
      continue;
    }
    try {
      outcomes.push({ ...head, ...(await runner.run({ module: prepared.module, runJson })) });
    } catch (error) {
      outcomes.push({
        ...head,
        status: "error",
        reason: `The runner failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return outcomes;
}

/** A failed Required evaluator fails the trial; an error or Advisory miss does not. */
export function codeEvaluatorsFailTrial(outcomes: readonly CodeEvaluatorOutcome[]): boolean {
  return outcomes.some(
    (o) => o.role === "required" && o.status === "scored" && !o.pass,
  );
}
