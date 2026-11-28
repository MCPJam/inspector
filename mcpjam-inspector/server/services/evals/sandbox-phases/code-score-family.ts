/**
 * The `code:<id>` score family (EFTW-90): one definition per code evaluator
 * the run froze, and one row per definition on every iteration that writes
 * score metadata.
 *
 * EVERY definition, on EVERY iteration, whether or not grading ran. A case's
 * iterations must share one `evaluationConfig.hash`, so an iteration whose
 * agent failed declares the same definitions as one that was graded, with a
 * `skipped` row instead of a score. Those iterations are already excluded from
 * the verdict, so the row changes nothing but the hash.
 *
 * Deterministic (its kind is an assertion), `idSource: explicit`. The role is
 * the author's: Required fails an iteration on a low score and, on an error or
 * a skip, makes it an evaluator error (left out of the pass rate, never
 * failed). `implementationHash` covers the script, its file name and its
 * interpreter, so editing a script starts a new score history and renaming
 * the evaluator doesn't.
 */
import { createHash } from "node:crypto";
import {
  authoredRequiredRole,
  canonicalDigest,
  errorScoreResult,
  finalizeScoreResult,
  skippedScoreResult,
  type ResolvedScoreDefinition,
  type ScoreDefinition,
  type ScoreResult,
} from "@mcpjam/sdk/contract";
import { interpreterFor, lastOutputLine } from "./exec.js";
import type { FrozenCodeEvaluator } from "./frozen-config.js";

export const CODE_SCORER_PREFIX = "code:";
export const CODE_EVALUATOR_CONTRACT_VERSION = "1";

export function codeScorerId(evaluatorId: string): string {
  return `${CODE_SCORER_PREFIX}${evaluatorId}`;
}

/** The score an iteration needs to pass: the author's, or 1. */
export function codeEvaluatorPassThreshold(
  evaluator: Pick<FrozenCodeEvaluator, "threshold">,
): number {
  return evaluator.threshold ?? 1;
}

export function codeEvaluatorScoreDefinition(
  evaluator: FrozenCodeEvaluator,
): ScoreDefinition {
  const required = evaluator.role === "required";
  return {
    scorerId: codeScorerId(evaluator.id),
    idSource: "explicit",
    scorerVersion: CODE_EVALUATOR_CONTRACT_VERSION,
    implementationHash: canonicalDigest({
      contract: Number(CODE_EVALUATOR_CONTRACT_VERSION),
      fileName: evaluator.fileName,
      command: interpreterFor(evaluator.fileName)?.join(" ") ?? null,
      sourceSha256: createHash("sha256").update(evaluator.script).digest("hex"),
    }),
    label: evaluator.name ?? evaluator.id,
    deterministic: true,
    passThreshold: codeEvaluatorPassThreshold(evaluator),
    role: required ? authoredRequiredRole() : "advisory",
    // Stated rather than defaulted: the backend's ingest check requires a
    // Required code evaluator to fail closed on both.
    onError: required ? "fail" : "ignore",
    onSkipped: required ? "fail" : "ignore",
  };
}

/** What one evaluator did in the grading box. */
export type CodeEvaluatorOutcome =
  | {
      kind: "scored";
      score: number;
      reason?: string;
      output: string;
      durationMs: number;
      exitCode: number;
    }
  | {
      kind: "error";
      error: string;
      output: string;
      durationMs?: number;
      exitCode?: number;
    };

/**
 * One iteration's grading: an outcome per evaluator id, or `notRun` with the
 * reason grading never ran (the agent failed, setup failed, the run stopped).
 */
export type CodeGradingResult = {
  evaluators: readonly FrozenCodeEvaluator[];
  outcomes: Record<string, CodeEvaluatorOutcome>;
  notRun?: string;
  /**
   * Where what the grading box was given is stored, once the backend
   * confirmed the upload (`grading-archive-upload.ts`). Absent otherwise.
   */
  gradingFilesStorageId?: string;
};

/** The rows for `result`, joined to the definitions in `byId`. */
export function codeEvaluatorRows(
  result: CodeGradingResult | undefined,
  byId: ReadonlyMap<string, ResolvedScoreDefinition>,
): ScoreResult[] {
  if (!result) return [];
  const rows: ScoreResult[] = [];
  for (const evaluator of result.evaluators) {
    const definition = byId.get(codeScorerId(evaluator.id));
    if (!definition) continue;
    const outcome = result.outcomes[evaluator.id];
    if (!outcome) {
      rows.push(skippedScoreResult(definition, result.notRun ?? "Not run."));
      continue;
    }
    if (outcome.kind === "error") {
      rows.push(errorScoreResult(definition, outcome.error));
      continue;
    }
    const excerpt = lastOutputLine(outcome.output);
    rows.push(
      finalizeScoreResult(definition, {
        kind: "scored",
        value: outcome.score,
        ...(outcome.reason ? { rationale: outcome.reason } : {}),
        ...(excerpt ? { evidence: [excerpt] } : {}),
      }),
    );
  }
  return rows;
}

/**
 * `metadata.codeEvaluatorLogs`: each evaluator's output tail, keyed by scorer
 * id. Kept beside the rows rather than in them, because a row's evidence is
 * capped at a few hundred characters and the tail is 8 KB.
 */
export function codeEvaluatorLogs(
  result: CodeGradingResult | undefined,
): Record<string, { output: string; durationMs?: number; exitCode?: number }> {
  const logs: Record<
    string,
    { output: string; durationMs?: number; exitCode?: number }
  > = {};
  for (const [id, outcome] of Object.entries(result?.outcomes ?? {})) {
    logs[codeScorerId(id)] = {
      output: outcome.output,
      ...(outcome.durationMs !== undefined
        ? { durationMs: outcome.durationMs }
        : {}),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    };
  }
  return logs;
}
