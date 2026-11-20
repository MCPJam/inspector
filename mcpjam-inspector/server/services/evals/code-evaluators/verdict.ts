import {
  finishEvalIterationVerdict,
  prepareEvalIterationVerdict,
  type EvalIterationVerdict,
  type EvalIterationVerdictInput,
} from "../iteration-verdict.js";
import { codeEvaluatorsFailTrial, runTrialCodeEvaluators } from "./run-iteration.js";
import type { CodeEvaluatorDefinition, CodeEvaluatorOutcome } from "./types.js";

/**
 * The trial's verdict with its code evaluators run first, on the same
 * transcript the checks read. With no code evaluators it is exactly
 * `buildEvalIterationVerdict`.
 */
export async function verdictWithCodeEvaluators(
  input: EvalIterationVerdictInput,
  code: {
    evaluators: readonly CodeEvaluatorDefinition[] | undefined;
    /** Trials sharing a key share a sandbox: the run id, else the iteration. */
    runKey: string;
  },
): Promise<EvalIterationVerdict & { codeEvaluatorResults: CodeEvaluatorOutcome[] }> {
  const prepared = prepareEvalIterationVerdict(input);
  const codeEvaluatorResults = await runTrialCodeEvaluators({
    evaluators: code.evaluators,
    run: prepared.transcript,
    runKey: code.runKey,
  });
  return {
    ...finishEvalIterationVerdict(
      prepared,
      input,
      codeEvaluatorsFailTrial(codeEvaluatorResults),
    ),
    codeEvaluatorResults,
  };
}
