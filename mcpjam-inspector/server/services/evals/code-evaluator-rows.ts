/**
 * Code evaluators as score rows: one `code:<id>` row per evaluator per
 * trial, deterministic, Required or Advisory as the author set it. Kept out
 * of `score-rows.ts` so that file stays inside its size limit.
 */
import {
  canonicalDigest,
  errorScoreResult,
  finalizeScoreResult,
  type ResolvedScoreDefinition,
  type ScoreDefinition,
  type ScoreResult,
} from "@mcpjam/sdk/contract";
import { CODE_EVALUATOR_RUNNER_VERSION } from "./code-evaluators/harness.js";
import type { CodeEvaluatorOutcome } from "./code-evaluators/types.js";

export const HOSTED_CODE_EVALUATOR_SCORER_PREFIX = "code:";

export type HostedCodeEvaluatorDefinitionInput = {
  id: string;
  label: string;
  role: "required" | "advisory";
  /** Digest of the source the trial ran. */
  sourceDigest: string;
};

export function hostedCodeEvaluatorScorerId(id: string): string {
  return `${HOSTED_CODE_EVALUATOR_SCORER_PREFIX}${id}`;
}

/**
 * The definition. Its hash covers the source and the runner version, so an
 * edit to the code starts a new history and a rename does not.
 */
export function hostedCodeEvaluatorScoreDefinition(
  args: HostedCodeEvaluatorDefinitionInput,
): ScoreDefinition {
  return {
    scorerId: hostedCodeEvaluatorScorerId(args.id),
    idSource: "platform",
    scorerVersion: CODE_EVALUATOR_RUNNER_VERSION,
    implementationHash: canonicalDigest({
      sourceDigest: args.sourceDigest,
      runner: CODE_EVALUATOR_RUNNER_VERSION,
    }),
    label: `code: ${args.label}`,
    deterministic: true,
    passThreshold: 1,
    role: args.role === "required" ? "gating" : "advisory",
  };
}


export function codeEvaluatorDefinitionInputs(
  outcomes: readonly CodeEvaluatorOutcome[] | undefined,
): HostedCodeEvaluatorDefinitionInput[] {
  return (outcomes ?? []).map((o) => ({
    id: o.id,
    label: o.label,
    role: o.role,
    sourceDigest: o.sourceDigest,
  }));
}

/** One row per outcome: pass is 1, fail is 0, an error has no value. */
export function codeEvaluatorScoreRows(
  outcomes: readonly CodeEvaluatorOutcome[] | undefined,
  byId: ReadonlyMap<string, ResolvedScoreDefinition>,
): ScoreResult[] {
  const rows: ScoreResult[] = [];
  for (const o of outcomes ?? []) {
    const definition = byId.get(hostedCodeEvaluatorScorerId(o.id));
    if (!definition) continue;
    rows.push(
      o.status === "error"
        ? errorScoreResult(definition, o.reason)
        : finalizeScoreResult(definition, {
            kind: "scored",
            value: o.pass ? 1 : 0,
            rationale: o.reason,
          }),
    );
  }
  return rows;
}
