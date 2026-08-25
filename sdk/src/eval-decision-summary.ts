import {
  stageDerivationSchema,
  STAGE_ANALYZER_VERSION,
  type FailureCategory,
  type StageResultRow,
  type UserValueStage,
} from "./contract/index.js";
import type { PlatformEvalIteration } from "./platform/types.js";

/**
 * THE extension point for later decision-summary actions (D7).
 *
 * `satisfies Record<FailureCategory, string>` makes adding a category to D1
 * fail this module's compilation until its operator action is written.
 */
export const NEXT_ACTION_BY_FAILURE_CATEGORY = Object.freeze({
  setup: "check the server connection and environment configuration",
  metadata: "review the tool metadata and descriptions in the server catalog",
  selection: "review tool selection and the tool catalog",
  arguments: "review the authored arguments against the tool input schema",
  serverData: "inspect the tool response returned by the server",
  userValue: "review whether the response answered the user's goal",
  evaluator: "check the evaluator configuration; the case was not graded",
} satisfies Record<FailureCategory, string>);

export const DECISION_SUMMARY_FALLBACK_NEXT_ACTION =
  "inspect the case trace; no failure category was recorded";

export type EvalDecisionVerdict = "passed" | "failed" | "incomplete";
export type StageChainStatus = "verified" | "unverified" | "absent";

export type EvalDecisionSummaryCase = {
  id: string;
  title: string;
  iterationNumber: number;
  firstFailedStage?: UserValueStage;
  failureCategory?: FailureCategory;
  stageChain?: StageResultRow[];
  stageChainStatus: StageChainStatus;
  stageAnalyzerVersionAhead?: { reported: number; known: number };
  expected?: { toolNames: string[] };
  observed?: { toolNames?: string[]; failure?: string };
  evidence?: {
    spanIds?: string[];
    promptIndexes?: number[];
    predicateReasons?: string[];
  };
  firstFailedTurnIndex?: number;
  nextAction: string;
};

export type EvalDecisionSummary = {
  verdict: EvalDecisionVerdict;
  passRate: {
    total: number;
    passed: number;
    failed: number;
    percent: number | null;
  };
  iterationWalkComplete: boolean;
  cases: EvalDecisionSummaryCase[];
};

export type NormalizedEvalDecisionCase = {
  id: string;
  title: string;
  iterationNumber: number;
  result: "passed" | "failed";
  expectedToolCalls?: readonly unknown[];
  actualToolCalls?: readonly unknown[];
  error?: string | null;
  stageResults?: unknown;
  firstFailedStage?: unknown;
  failureCategory?: unknown;
  stageAnalyzerVersion?: unknown;
  stageResultsUnverified?: true;
  firstFailedTurnIndex?: number;
};

export type EvalDecisionSummaryInput = {
  total: number;
  passed: number;
  failed: number;
  iterationWalkComplete: boolean;
  cases: NormalizedEvalDecisionCase[];
};

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toolName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return (
    stringField(record.toolName) ??
    stringField(record.tool) ??
    stringField(record.name)
  );
}

function toolNames(calls: readonly unknown[] | undefined): string[] | undefined {
  const names = (calls ?? []).map(toolName).filter((name): name is string => !!name);
  return names.length > 0 ? names : undefined;
}

function verifiedDerivation(
  row: NormalizedEvalDecisionCase
): ReturnType<typeof stageDerivationSchema.safeParse> {
  return stageDerivationSchema.safeParse({
    stageResults: row.stageResults,
    ...(row.firstFailedStage !== undefined
      ? { firstFailedStage: row.firstFailedStage }
      : {}),
    ...(row.failureCategory !== undefined
      ? { failureCategory: row.failureCategory }
      : {}),
    stageAnalyzerVersion: row.stageAnalyzerVersion,
  });
}

function collectEvidence(rows: StageResultRow[]): EvalDecisionSummaryCase["evidence"] {
  const spanIds: string[] = [];
  const promptIndexes: number[] = [];
  const predicateReasons: string[] = [];
  const seenSpans = new Set<string>();
  const seenPrompts = new Set<number>();
  const seenReasons = new Set<string>();

  for (const row of rows) {
    for (const spanId of row.evidence?.spanIds ?? []) {
      if (!seenSpans.has(spanId)) {
        seenSpans.add(spanId);
        spanIds.push(spanId);
      }
    }
    for (const promptIndex of row.evidence?.promptIndexes ?? []) {
      if (!seenPrompts.has(promptIndex)) {
        seenPrompts.add(promptIndex);
        promptIndexes.push(promptIndex);
      }
    }
    for (const reason of row.evidence?.predicateReasons ?? []) {
      if (!seenReasons.has(reason)) {
        seenReasons.add(reason);
        predicateReasons.push(reason);
      }
    }
  }

  const evidence = {
    ...(spanIds.length > 0 ? { spanIds } : {}),
    ...(promptIndexes.length > 0 ? { promptIndexes } : {}),
    ...(predicateReasons.length > 0 ? { predicateReasons } : {}),
  };
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function summaryCase(row: NormalizedEvalDecisionCase): EvalDecisionSummaryCase {
  const derivation = verifiedDerivation(row);
  const verified = derivation.success;
  const stageChainStatus: StageChainStatus = verified
    ? "verified"
    : row.stageResultsUnverified === true || row.stageResults !== undefined
      ? "unverified"
      : "absent";
  const category = verified
    ? derivation.data.failureCategory
    : undefined;
  const reportedVersion =
    typeof row.stageAnalyzerVersion === "number" &&
    Number.isInteger(row.stageAnalyzerVersion) &&
    row.stageAnalyzerVersion >= 0
      ? row.stageAnalyzerVersion
      : undefined;
  const expected = toolNames(row.expectedToolCalls);
  const observedNames = toolNames(row.actualToolCalls);
  const failure = stringField(row.error);

  return {
    id: row.id,
    title: row.title,
    iterationNumber: row.iterationNumber,
    ...(verified && derivation.data.firstFailedStage
      ? { firstFailedStage: derivation.data.firstFailedStage }
      : {}),
    ...(category ? { failureCategory: category } : {}),
    ...(verified ? { stageChain: derivation.data.stageResults } : {}),
    stageChainStatus,
    ...(reportedVersion !== undefined && reportedVersion > STAGE_ANALYZER_VERSION
      ? {
          stageAnalyzerVersionAhead: {
            reported: reportedVersion,
            known: STAGE_ANALYZER_VERSION,
          },
        }
      : {}),
    ...(expected ? { expected: { toolNames: expected } } : {}),
    ...(observedNames || failure
      ? {
          observed: {
            ...(observedNames ? { toolNames: observedNames } : {}),
            ...(failure ? { failure } : {}),
          },
        }
      : {}),
    ...(verified ? { evidence: collectEvidence(derivation.data.stageResults) } : {}),
    ...(typeof row.firstFailedTurnIndex === "number"
      ? { firstFailedTurnIndex: row.firstFailedTurnIndex }
      : {}),
    nextAction: category
      ? NEXT_ACTION_BY_FAILURE_CATEGORY[category]
      : DECISION_SUMMARY_FALLBACK_NEXT_ACTION,
  };
}

export function buildEvalDecisionSummary(
  input: EvalDecisionSummaryInput
): EvalDecisionSummary {
  const percent =
    input.total === 0
      ? null
      : Math.round((input.passed / input.total) * 10000) / 100;
  const verdict: EvalDecisionVerdict =
    input.total === 0 || !input.iterationWalkComplete
      ? "incomplete"
      : input.failed > 0
        ? "failed"
        : "passed";
  return {
    verdict,
    passRate: {
      total: input.total,
      passed: input.passed,
      failed: input.failed,
      percent,
    },
    iterationWalkComplete: input.iterationWalkComplete,
    cases: input.cases
      .filter((row) => row.result === "failed")
      .map(summaryCase),
  };
}

export function buildEvalDecisionSummaryFromIterations(
  iterations: PlatformEvalIteration[],
  input: {
    total?: number;
    passed?: number;
    failed?: number;
    iterationWalkComplete: boolean;
  }
): EvalDecisionSummary {
  const failedRows = iterations.filter((iteration) => iteration.result === "failed");
  const total = input.total ?? iterations.length;
  const failed = input.failed ?? failedRows.length;
  const passed = input.passed ?? Math.max(total - failed, 0);
  return buildEvalDecisionSummary({
    total,
    passed,
    failed,
    iterationWalkComplete: input.iterationWalkComplete,
    cases: iterations.map((iteration) => ({
      id: iteration.id,
      title: iteration.title ?? iteration.id,
      iterationNumber: iteration.iterationNumber,
      result: iteration.result === "failed" ? "failed" : "passed",
      expectedToolCalls: iteration.expectedToolCalls,
      actualToolCalls: iteration.actualToolCalls,
      error: iteration.error,
      stageResults: iteration.stageResults,
      firstFailedStage: iteration.firstFailedStage,
      failureCategory: iteration.failureCategory,
      stageAnalyzerVersion: iteration.stageAnalyzerVersion,
      stageResultsUnverified: iteration.stageResultsUnverified,
    })),
  });
}

function formatValueList(values: string[] | number[]): string {
  return values.join(", ");
}

export function formatEvalDecisionSummary(
  summary: EvalDecisionSummary
): string {
  const rate =
    summary.passRate.percent === null
      ? "no cases"
      : String(summary.passRate.percent);
  const partial = summary.iterationWalkComplete
    ? ""
    : " (partial iteration walk)";
  const lines = [
    `Decision summary: ${summary.verdict} — ${summary.passRate.passed}/${summary.passRate.total} cases passed (${
      summary.passRate.percent === null ? rate : `${rate}%`
    })${partial}`,
  ];

  for (const item of summary.cases) {
    lines.push(
      item.title === item.id
        ? `  ${item.title} (iteration ${item.iterationNumber})`
        : `  ${item.title} (${item.id}, iteration ${item.iterationNumber})`
    );
    const firstFailedStageLine =
      item.stageChainStatus === "verified"
        ? item.firstFailedStage
          ? `first failed stage ${item.firstFailedStage}`
          : "no first failed stage — did not reach the server's stages"
        : item.stageChainStatus === "unverified"
          ? "first failed stage not established because the stage chain was unverified"
          : "no stage metadata was recorded for this run, so no first failed stage is known";
    lines.push(`    ${firstFailedStageLine}`);
    lines.push(
      `    ${
        item.failureCategory
          ? `failure category ${item.failureCategory}`
          : "failure category not reported"
      }`
    );
    if (item.expected) {
      lines.push(`    expected tool calls: ${formatValueList(item.expected.toolNames)}`);
    }
    if (item.observed) {
      if (item.observed.toolNames) {
        lines.push(
          `    observed tool calls: ${formatValueList(item.observed.toolNames)}`
        );
      }
      if (item.observed.failure) {
        lines.push(`    observed failure: ${item.observed.failure}`);
      }
    }
    if (item.evidence) {
      const parts = [
        ...(item.evidence.spanIds
          ? [`span ids ${formatValueList(item.evidence.spanIds)}`]
          : []),
        ...(item.evidence.promptIndexes
          ? [`prompt indexes ${formatValueList(item.evidence.promptIndexes)}`]
          : []),
        ...(item.evidence.predicateReasons
          ? [`reasons ${formatValueList(item.evidence.predicateReasons)}`]
          : []),
      ];
      lines.push(`    evidence: ${parts.join("; ")}`);
    }
    if (item.stageChainStatus === "unverified") {
      lines.push("    stage chain unverified — chain omitted");
    }
    if (item.stageAnalyzerVersionAhead) {
      lines.push(
        `    stage chain reported by a newer analyzer (version ${item.stageAnalyzerVersionAhead.reported}, this build knows ${item.stageAnalyzerVersionAhead.known})`
      );
    }
    lines.push(`    next action: ${item.nextAction}`);
  }
  return lines.join("\n");
}
