/**
 * Custom judge rows on an iteration's scorecard (evaluator library slice 3).
 *
 * Kept out of `trial-results.ts` so that file stays inside its size limit.
 */
import type { EvalIteration } from "@/components/evals/types";
import {
  parseEvaluationConfig,
  parseIterationScores,
} from "@/components/evals/scores-list";
import { customJudgeFailureCopy } from "@/components/evals/evaluator-library/custom-judge-failure-copy";
import { HOSTED_CUSTOM_JUDGE_SCORER_PREFIX } from "@/shared/hosted-criterion-id";
import {
  indexScores,
  resultFromScore,
  scoreEvidence,
  type JoinedScorecardRow,
  type TrialRowResult,
} from "./trial-results";

type CustomJudgeOutputKind = "score" | "passfail";

type StoredCustomJudge = {
  id: string;
  label: string;
  result: TrialRowResult;
  evaluatorId?: string;
  outputKind?: CustomJudgeOutputKind;
  /** The judge's pass line, from its saved output format. */
  threshold?: number;
};

const DEFINITION_LABEL_PREFIX = "custom judge: ";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isUnitValue(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

const COULD_NOT_RUN = "The judge could not run on this iteration. Rerun the suite to try again.";

/** The backend's own reason first, then copy for its code, never a bare code. */
function errorReason(code: string | undefined, reason: string | undefined) {
  return reason || customJudgeFailureCopy(code) || COULD_NOT_RUN;
}

/**
 * A projected error row's `error` is the judge's code and reason joined as
 * `code: reason` (`custom-judge-rows.ts`); shown as the reason alone. With no
 * code, the backend stores the error's name instead (`TimeoutError`).
 */
function readableError(result: TrialRowResult): TrialRowResult {
  if (result.state !== "error") return result;
  const match = /^([A-Za-z0-9_]+)(?:: ([\s\S]*))?$/.exec(result.reason ?? "");
  if (!match) return result;
  return { ...result, reason: errorReason(match[1], match[2]) };
}

function storedResult(
  entry: Record<string, unknown>,
  output: Record<string, unknown> | undefined,
): TrialRowResult {
  const reason = typeof entry.reason === "string" ? entry.reason : undefined;
  const threshold = output?.kind === "passfail" ? 0.5 : output?.threshold;
  // The verdict's own `passed`, or the projection's rule when it has none.
  const passed =
    typeof entry.passed === "boolean"
      ? entry.passed
      : isUnitValue(entry.value) && isUnitValue(threshold)
        ? entry.value >= threshold
        : undefined;
  if (
    entry.status === "scored" &&
    isUnitValue(entry.value) &&
    passed !== undefined
  ) {
    return {
      state: passed ? "passed" : "failed",
      source: "modelVerdict",
      value: entry.value,
      reason,
      ...(isUnitValue(threshold) ? { threshold } : {}),
    };
  }
  return {
    state: "error",
    source: "modelVerdict",
    reason: errorReason(
      typeof entry.error === "string" ? entry.error : undefined,
      reason,
    ),
  };
}

/** The judges `metadata.customJudgesVerdict` lists, in the order they ran. */
function readStoredCustomJudges(verdict: unknown): StoredCustomJudge[] {
  const entries = record(verdict)?.judges;
  if (!Array.isArray(entries)) return [];
  const judges: StoredCustomJudge[] = [];
  for (const value of entries) {
    const entry = record(value);
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id) ||
      typeof entry.label !== "string" ||
      !entry.label
    ) {
      continue;
    }
    const output = record(entry.output);
    const origin = record(entry.evaluator);
    const threshold = output?.kind === "passfail" ? 0.5 : output?.threshold;
    judges.push({
      id: entry.id,
      label: entry.label,
      result: storedResult(entry, output),
      ...(typeof origin?.id === "string" && origin.id
        ? { evaluatorId: origin.id }
        : {}),
      ...(output?.kind === "score" || output?.kind === "passfail"
        ? { outputKind: output.kind }
        : {}),
      ...(isUnitValue(threshold) ? { threshold } : {}),
    });
  }
  return judges;
}

/**
 * The scorer ids of the iteration's hosted custom judges: rows the judge
 * pass projected, under a platform definition. An SDK judge whose author
 * named it `judge:custom:…` has an explicit id and is not one.
 */
export function hostedCustomJudgeScorerIds(
  metadata: Record<string, unknown> | undefined,
): Set<string> {
  const definitions = parseEvaluationConfig(metadata)?.definitions ?? [];
  return new Set(
    definitions
      .filter(
        (definition) =>
          definition.idSource === "platform" &&
          definition.scorerId.startsWith(HOSTED_CUSTOM_JUDGE_SCORER_PREFIX),
      )
      .map((definition) => definition.scorerId),
  );
}

function customJudgeRow(
  id: string,
  label: string,
  result: TrialRowResult,
  identity: Pick<StoredCustomJudge, "evaluatorId" | "outputKind" | "threshold">,
): JoinedScorecardRow {
  const scorerId = `${HOSTED_CUSTOM_JUDGE_SCORER_PREFIX}${id}`;
  const { evaluatorId, outputKind, threshold } = identity;
  return {
    key: scorerId,
    stage: "userValue",
    provenance: "customJudge",
    label,
    kindLabel: "Judge",
    role: "advisory",
    roleLock: "judge",
    editable: false,
    customJudge: {
      ...(evaluatorId ? { evaluatorId } : {}),
      ...(outputKind ? { outputKind } : {}),
    },
    // From the judge's configuration, not the result: an error has none.
    expectation:
      outputKind !== "passfail" && threshold !== undefined
        ? `Score of ${threshold} or higher`
        : "Pass",
    tooltip: "A judge prompt this suite wrote. Advisory.",
    join: { kind: "judge", slot: "customJudges", scorerId },
    result,
  };
}

/**
 * The iteration's recorded custom judge results, never the suite's live
 * prompts. A projected score row wins over the saved verdict it came from,
 * as rubric checks do; the verdict sets the order, names the judge's library
 * origin and output format, and stands in only for a judge with no projected
 * row yet.
 */
export function customJudgeIterationRows(
  iteration: EvalIteration | null,
): JoinedScorecardRow[] {
  const metadata = iteration?.metadata;
  if (!metadata) return [];
  const scores = indexScores(
    parseIterationScores(metadata),
    parseEvaluationConfig(metadata),
  );
  const stored = new Map(
    readStoredCustomJudges(metadata.customJudgesVerdict).map((judge) => [
      `${HOSTED_CUSTOM_JUDGE_SCORER_PREFIX}${judge.id}`,
      judge,
    ]),
  );
  const projected = new Map<string, JoinedScorecardRow>();
  for (const [scorerId, { score, definition }] of scores.byScorerId) {
    if (
      !scorerId.startsWith(HOSTED_CUSTOM_JUDGE_SCORER_PREFIX) ||
      definition?.idSource !== "platform"
    ) {
      continue;
    }
    const id = scorerId.slice(HOSTED_CUSTOM_JUDGE_SCORER_PREFIX.length);
    const saved = stored.get(scorerId);
    const defined = definition?.label ?? "";
    const label =
      (defined.startsWith(DEFINITION_LABEL_PREFIX)
        ? defined.slice(DEFINITION_LABEL_PREFIX.length)
        : defined) ||
      saved?.label ||
      id;
    const row = customJudgeRow(
      id,
      label,
      readableError(resultFromScore(score, definition)),
      {
        evaluatorId: saved?.evaluatorId,
        outputKind: saved?.outputKind,
        threshold: definition.passThreshold,
      },
    );
    const evidence = scoreEvidence(score, definition, row);
    projected.set(scorerId, { ...row, ...(evidence ? { evidence } : {}) });
  }
  const rows: JoinedScorecardRow[] = [];
  for (const [scorerId, saved] of stored) {
    rows.push(
      projected.get(scorerId) ??
        customJudgeRow(saved.id, saved.label, saved.result, saved),
    );
    projected.delete(scorerId);
  }
  return [...rows, ...projected.values()];
}
