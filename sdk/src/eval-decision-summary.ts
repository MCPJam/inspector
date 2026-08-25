/**
 * The eval decision summary: the canonical contract's platform-typed entry, its
 * human renderer, and the compatibility surface that preceded it.
 *
 * ── Where the contract lives ─────────────────────────────────────────────────
 *
 * {@link EvalRunDecisionSummary} — the versioned shape the API returns, the
 * Platform MCP server hands to a model, and every CLI reporter restates — is
 * defined in `./contract/decision-summary.ts` and assembled by
 * {@link assembleEvalRunDecisionSummary}. This module adds two things the
 * contract subpath deliberately cannot have: types from `./platform/types.js`
 * (the contract stays free of them so it can be bundled into a browser), and
 * the prose renderer.
 *
 * ── What is kept for compatibility ───────────────────────────────────────────
 *
 * {@link buildEvalDecisionSummary}, {@link buildEvalDecisionSummaryFromIterations}
 * and {@link formatEvalDecisionSummary} are the SHIPPED per-case summary. They
 * are deprecated, unchanged, and still exported: `@mcpjam/sdk` has consumers on
 * them and removing an export is a break, not a cleanup. Nothing inside this
 * repo calls them any more — the CLI, the reporters and the API all assemble
 * the canonical contract instead — because their verdict is computed from
 * ITERATION COUNTS, which is a second, disagreeing answer to a question the
 * run's own `EvalVerdictDecision` already answered. Two verdict engines over
 * one run is the drift the canonical contract exists to remove; keeping this
 * one reachable but unused is how that is done without breaking anybody.
 */
import {
  DECISION_SUMMARY_FALLBACK_NEXT_ACTION,
  EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS,
  EVAL_RUN_DECISION_VERDICT_LABELS,
  EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS,
  EVAL_VERDICT_DECISION_REASON_LABELS,
  FAILURE_CATEGORY_LABELS,
  NEXT_ACTION_BY_FAILURE_CATEGORY,
  STAGE_ANALYZER_VERSION,
  STAGE_REASON_LABELS,
  USER_VALUE_STAGE_LABELS,
  assembleEvalRunDecisionSummary,
  measurementUnitLabel,
  stageDerivationSchema,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
  type FailureCategory,
  type StageResultRow,
  type UserValueStage,
} from "./contract/index.js";
import type {
  PlatformEvalIteration,
  PlatformEvalRun,
} from "./platform/types.js";

/**
 * The operator action for one failure category, and the words used when no
 * category was established.
 *
 * RELOCATED to `./contract/decision-labels.ts` — the remediation copy now sits
 * beside the vocabularies it is keyed on, so a new category fails compilation
 * there rather than silently rendering as a missing action. Re-exported under
 * their published names because both are part of `@mcpjam/sdk`'s surface.
 */
export { DECISION_SUMMARY_FALLBACK_NEXT_ACTION, NEXT_ACTION_BY_FAILURE_CATEGORY };

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

/**
 * @deprecated Use {@link buildEvalRunDecisionSummary} (or
 * `assembleEvalRunDecisionSummary` from `@mcpjam/sdk/contract`). This computes a
 * verdict by counting iterations, which disagrees with the run's own
 * `EvalVerdictDecision` whenever a case has repetitions: it reads N trials as N
 * cases, and a case that passed 4 of 5 trials reads here as one pass and one
 * failure. Kept exported and unchanged for existing consumers.
 */
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

/**
 * @deprecated Use {@link buildEvalRunDecisionSummary}, which takes the run as
 * well as its iterations and therefore reports the verdict the platform
 * actually reached. See {@link buildEvalDecisionSummary}.
 */
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

/**
 * @deprecated Use {@link formatEvalRunDecisionSummary}. This renders raw wire
 * enums (`userValue`, `argumentMismatch`) at a human.
 */
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

// ── the canonical contract, platform-typed ───────────────────────────────────

/**
 * Assemble the canonical summary from a platform run and ONE page of its
 * iterations.
 *
 * A thin, typed wrapper over {@link assembleEvalRunDecisionSummary}: the DTOs
 * satisfy the contract's structural inputs by construction, and going through
 * one function is what makes the API's summary and a client's fallback summary
 * byte-equivalent for the same input. Fetching and pagination stay OUT of it —
 * the caller decides how much of the run it walked and says so in `page`.
 */
export function buildEvalRunDecisionSummary(input: {
  projectId: string;
  run: PlatformEvalRun;
  iterations: readonly PlatformEvalIteration[];
  page: { complete: boolean; nextCursor?: string };
}): EvalRunDecisionSummary {
  return assembleEvalRunDecisionSummary({
    projectId: input.projectId,
    run: input.run,
    iterations: input.iterations,
    page: input.page,
  });
}

// ── the human renderer ───────────────────────────────────────────────────────

/**
 * Render the canonical summary as prose.
 *
 * Every enum passes through the label maps beside the contract, so a terminal
 * says `User value` and `the call arguments did not match what the case
 * expects` rather than `userValue` and `argumentMismatch`. Nothing here
 * inspects the run again: this is presentation over an already-decided object.
 */
export function formatEvalRunDecisionSummary(
  summary: EvalRunDecisionSummary
): string {
  const lines: string[] = [formatDecisionHeadline(summary)];

  if (summary.undecided) {
    lines.push(
      `  Why: ${EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS[summary.undecided.reason]}`
    );
    if (summary.undecided.detail) {
      lines.push(`  Detail: ${summary.undecided.detail}`);
    }
  }

  for (const reason of summary.decision?.reasons ?? []) {
    lines.push(`  Why: ${EVAL_VERDICT_DECISION_REASON_LABELS[reason]}`);
  }

  lines.push(formatDiagnosticsHeadline(summary));
  for (const item of summary.diagnostics.items) {
    lines.push(...formatDecisionDiagnostic(item));
  }
  return lines.join("\n");
}

function formatDecisionHeadline(summary: EvalRunDecisionSummary): string {
  const verdict = EVAL_RUN_DECISION_VERDICT_LABELS[summary.verdict];
  const source = EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS[summary.verdictSource];
  const counts = summary.counts;
  if (counts === undefined) {
    return summary.verdictSource === "none"
      ? `Decision summary: ${verdict}`
      : `Decision summary: ${verdict} (${source}) — no counts were recorded`;
  }
  // The unit is printed with the numbers, never inferred from them: a legacy
  // run's "3 passed" counts trials and a policy-v2 run's counts case
  // execution variants, and the same suite reports different totals for each.
  if (counts.measurementUnit === "caseVariant") {
    const unit = measurementUnitLabel("caseVariant", counts.total);
    const inconclusive =
      counts.inconclusive > 0 ? `, ${counts.inconclusive} inconclusive` : "";
    return (
      `Decision summary: ${verdict} (${source}) — ${counts.passed}/${counts.total} ` +
      `${unit} passed, ${counts.failed} failed${inconclusive}`
    );
  }
  const parts = [
    counts.total !== undefined && counts.passed !== undefined
      ? `${counts.passed}/${counts.total} ${measurementUnitLabel("trial", counts.total)} passed`
      : counts.passed !== undefined
        ? `${counts.passed} passed`
        : undefined,
    counts.failed !== undefined ? `${counts.failed} failed` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `Decision summary: ${verdict} (${source})${
    parts.length > 0 ? ` — ${parts.join(", ")}` : ""
  }`;
}

/**
 * How much of the run these diagnostics came from.
 *
 * Printed even when there are none, because "we examined 40 trials and none of
 * them failed" and "we did not look" render identically otherwise — and only
 * one of them means the list below is the whole story.
 */
function formatDiagnosticsHeadline(summary: EvalRunDecisionSummary): string {
  const { items, scannedIterations, complete } = summary.diagnostics;
  const scope = complete
    ? "the complete set"
    : "a PARTIAL page — more trials were not examined";
  return (
    `  Diagnostics: ${items.length} non-passing of ${scannedIterations} ` +
    `${measurementUnitLabel("trial", scannedIterations)} examined (${scope})`
  );
}

function formatDecisionDiagnostic(item: EvalRunDecisionDiagnostic): string[] {
  const identity = [item.caseId ?? item.testCaseId, `iteration ${item.iterationNumber}`]
    .filter((part): part is string => !!part)
    .join(", ");
  const lines = [
    `  ${item.title ?? item.iterationId} (${identity}) — ${
      item.result ?? item.status
    }`,
  ];

  if (item.chain.status === "verified") {
    const stage = item.chain.firstFailedStage;
    if (stage) {
      const row = item.chain.stages.find((entry) => entry.stage === stage);
      const because = row?.reason
        ? ` — ${STAGE_REASON_LABELS[row.reason]}`
        : "";
      lines.push(
        `    First failed stage: ${USER_VALUE_STAGE_LABELS[stage]}${because}`
      );
    } else {
      lines.push(
        "    First failed stage: none was established — the run never reached the server's stages"
      );
    }
    lines.push(
      item.chain.failureCategory
        ? `    Failure category: ${FAILURE_CATEGORY_LABELS[item.chain.failureCategory]}`
        : "    Failure category: not reported"
    );
  } else if (item.chain.status === "unverified") {
    lines.push(
      "    First failed stage: not established — the recorded stage chain did not validate, so it is withheld"
    );
  } else {
    lines.push(
      "    First failed stage: not established — this run recorded no stage chain"
    );
  }

  if (item.chain.status !== "absent" && item.chain.analyzerVersionAhead) {
    lines.push(
      `    Stage chain came from a newer analyzer (version ${item.chain.analyzerVersionAhead.reported}; this build knows ${item.chain.analyzerVersionAhead.known})`
    );
  }
  if (item.expected) {
    lines.push(`    Expected tool calls: ${item.expected.toolNames.join(", ")}`);
  }
  if (item.observed?.toolNames) {
    lines.push(`    Observed tool calls: ${item.observed.toolNames.join(", ")}`);
  }
  if (item.observed?.failure) {
    lines.push(`    Observed failure: ${item.observed.failure}`);
  }
  const evidence = [
    ...(item.evidence.spanIds
      ? [`span ids ${item.evidence.spanIds.join(", ")}`]
      : []),
    ...(item.evidence.promptIndexes
      ? [`prompt indexes ${item.evidence.promptIndexes.join(", ")}`]
      : []),
    ...(item.evidence.reasons ? [`reasons ${item.evidence.reasons.join(", ")}`] : []),
  ];
  if (evidence.length > 0) {
    // Named with the stage it was read from, because that is the only stage it
    // is evidence ABOUT — the passing stages have their own spans and they are
    // not an explanation of this failure.
    const stage = item.evidence.stage
      ? ` at ${USER_VALUE_STAGE_LABELS[item.evidence.stage]}`
      : "";
    lines.push(`    Evidence${stage}: ${evidence.join("; ")}`);
  }
  lines.push(`    Trace: ${item.evidence.tracePath}`);
  lines.push(`    Next action: ${item.nextAction}`);
  return lines;
}
