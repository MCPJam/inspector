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
  STAGE_STATE_LABELS,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGES,
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
import type { PlatformApiClient } from "./platform/client.js";

const DECISION_SUMMARY_FALLBACK_PAGE_LIMIT = 200;
const DECISION_SUMMARY_FALLBACK_MAX_PAGES = 100;

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

/**
 * Read the canonical summary with one compatibility path for older API
 * deployments.
 *
 * The endpoint is preferred because it can return a bounded diagnostic page.
 * If it is absent, the fallback walks the same iteration resource and hands
 * the rows to the same shared assembler. An opaque cursor cannot be replayed
 * locally, so a cursored request returns no fallback rather than silently
 * returning the wrong page.
 */
export async function readEvalRunDecisionSummary(
  client: Pick<
    PlatformApiClient,
    "getEvalRunDecisionSummary" | "listEvalRunIterations"
  >,
  signal: AbortSignal | undefined,
  projectId: string,
  run: PlatformEvalRun,
  options: { cursor?: string; limit?: number } = {}
): Promise<EvalRunDecisionSummary | undefined> {
  try {
    return await client.getEvalRunDecisionSummary(
      {
        projectId,
        runId: run.id,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit: options.limit ?? DECISION_SUMMARY_FALLBACK_PAGE_LIMIT,
      },
      { signal }
    );
  } catch {
    if (options.cursor !== undefined || signal?.aborted) return undefined;
  }

  try {
    const items: PlatformEvalIteration[] = [];
    let cursor: string | undefined;
    let nextCursor: string | undefined;
    for (let page = 0; page < DECISION_SUMMARY_FALLBACK_MAX_PAGES; page += 1) {
      const result = await client.listEvalRunIterations(
        {
          projectId,
          runId: run.id,
          ...(cursor ? { cursor } : {}),
          limit: DECISION_SUMMARY_FALLBACK_PAGE_LIMIT,
        },
        { signal }
      );
      items.push(...result.items);
      if (!result.nextCursor) {
        return buildEvalRunDecisionSummary({
          projectId,
          run,
          iterations: items,
          page: { complete: true },
        });
      }
      nextCursor = result.nextCursor;
      cursor = result.nextCursor;
    }

    return buildEvalRunDecisionSummary({
      projectId,
      run,
      iterations: items,
      page: { complete: false, ...(nextCursor ? { nextCursor } : {}) },
    });
  } catch {
    return undefined;
  }
}

// ── the human renderer ───────────────────────────────────────────────────────

/**
 * How much detail the prose renderer prints.
 *
 * `stages` is the DETAILED layer: all six chain rows for every diagnostic,
 * rather than the one line naming where the chain first broke. Off by default
 * so every existing caller's output volume is unchanged — a fan-out of twenty
 * failing trials would otherwise gain a hundred and twenty lines nobody asked
 * for. The compact chain line below is NOT optional: it is the answer the
 * summary owes a reader, not an enrichment.
 */
export type FormatEvalRunDecisionSummaryOptions = {
  stages?: boolean;
};

/**
 * Render the canonical summary as prose.
 *
 * THE ORDER IS THE CONTRACT: what was decided → how much was measured → where
 * the chain broke → the supporting evidence → the next owner. A reader who
 * stops after two lines has the verdict and the population it covers; one who
 * stops after three also knows where value stopped travelling.
 *
 * Every enum passes through the label maps beside the contract, so a terminal
 * says `User value` and `the call arguments did not match what the case
 * expects` rather than `userValue` and `argumentMismatch`. Nothing here
 * inspects the run again: this is presentation over an already-decided object.
 *
 * Human output is not a stable contract — `--format json` is. That is what
 * makes it safe to lead with the chain line rather than gate it behind a flag.
 */
export function formatEvalRunDecisionSummary(
  summary: EvalRunDecisionSummary,
  options: FormatEvalRunDecisionSummaryOptions = {}
): string {
  const lines: string[] = [formatDecisionHeadline(summary)];

  if (summary.undecided) {
    lines.push(
      `  Why: ${
        labelFor(
          EVAL_RUN_DECISION_UNDECIDED_REASON_LABELS,
          summary.undecided.reason
        ) ?? ""
      }`
    );
    if (summary.undecided.detail) {
      lines.push(`  Detail: ${summary.undecided.detail}`);
    }
  }

  for (const reason of summary.decision?.reasons ?? []) {
    const label = labelFor(EVAL_VERDICT_DECISION_REASON_LABELS, reason);
    if (label !== undefined) lines.push(`  Why: ${label}`);
  }

  lines.push(formatDiagnosticsHeadline(summary));
  const firstBreak = formatFirstBreakLine(summary);
  if (firstBreak) lines.push(firstBreak);
  for (const item of summary.diagnostics.items) {
    lines.push(...formatDecisionDiagnostic(item, options));
  }
  return lines.join("\n");
}

/**
 * A member's label, or `undefined` for anything the map does not OWN.
 *
 * The type says these keys are closed; the RUNTIME value came off the wire and
 * nothing on this path validates it against the vocabulary. A payload whose
 * `reason` reads `"constructor"` therefore resolves through
 * `Object.prototype` to a function — truthy — and a caller that drops the
 * clause on a falsy label instead prints
 * `function Object() { [native code] }` at a human.
 *
 * Used by EVERY label lookup in this file — the chain rows, the per-diagnostic
 * rows, the verdict headline, its source, and both kinds of "Why" line.
 * Hardening a subset would leave the same payload class leaking function
 * source from whichever lookup was left out, which is a more confusing change
 * than either extreme rather than a smaller one.
 */
function labelFor<TMember extends string>(
  labels: Readonly<Record<TMember, string>>,
  member: TMember | undefined
): string | undefined {
  return typeof member === "string" &&
    Object.prototype.hasOwnProperty.call(labels, member)
    ? labels[member]
    : undefined;
}

/**
 * WHERE THE CHAIN BROKE for this run, in one line, above the per-trial detail.
 *
 * The stage is the EARLIEST one in chain order at which any readable trial
 * broke — "first" here means what it means everywhere else in this contract, a
 * position in `USER_VALUE_STAGES`, never "the most common". The count beside it
 * is what keeps that honest: a run whose only connection failure sits under
 * nine user-value failures reports `1 of 10`, and says so again by naming how
 * many distinct stages broke.
 *
 * ON A PARTIAL PAGE the line says so, because "earliest" is then a claim about
 * the rows in hand rather than about the run: an unlisted trial can have broken
 * at a stage further up the chain, and a reader told "First break: Response"
 * would act on a stage the run may not have stopped at. Same discipline as the
 * diagnostics headline directly above it, which already refuses to present a
 * page as the whole failure set.
 *
 * The denominator is the READABLE population these diagnostics carry — trials
 * whose chain validated — and never a stage-analytics denominator: that is a
 * different document, computed over a different population, and mixing the two
 * would produce a rate belonging to neither.
 *
 * Skipped for a passing run, which has no break to name.
 *
 * Returns `undefined` rather than a hedge whenever nothing is established.
 */
function formatFirstBreakLine(
  summary: EvalRunDecisionSummary
): string | undefined {
  if (summary.verdict === "passed") return undefined;
  const items = summary.diagnostics.items;
  if (items.length === 0) return undefined;

  const readable = items.filter((item) => item.chain.status === "verified");
  if (readable.length === 0) {
    return (
      `  ${
        summary.diagnostics.complete
          ? "First break"
          : "First break ON THIS PAGE"
      }: not established — none of the ` +
      `${items.length} ${measurementUnitLabel("trial", items.length)} ` +
      "below recorded a chain that could be read"
    );
  }

  const brokeAt = new Map<UserValueStage, number>();
  for (const item of readable) {
    const stage =
      item.chain.status === "verified"
        ? item.chain.firstFailedStage
        : undefined;
    if (stage) brokeAt.set(stage, (brokeAt.get(stage) ?? 0) + 1);
  }
  const unit = measurementUnitLabel("trial", readable.length);
  if (brokeAt.size === 0) {
    // Every readable chain established a category and no stage — a setup abort
    // or an evaluator error. Naming a stage here would put a location on a run
    // that never reached one.
    //
    // The COUNT is of the trials that actually CARRY a category, not of every
    // readable trial. A readable chain can establish neither a stage nor a
    // category, and saying "3 measured trials" grouped under one bucket when
    // only two name it would attribute the third to a bucket nothing put it
    // in — the same over-claim the spread clause below exists to avoid.
    const grouped = readable.flatMap((item) =>
      item.chain.status === "verified" && item.chain.failureCategory
        ? [
            labelFor(FAILURE_CATEGORY_LABELS, item.chain.failureCategory),
          ].filter((label): label is string => label !== undefined)
        : []
    );
    const categories = [...new Set(grouped)];
    const ungrouped = readable.length - grouped.length;
    return categories.length > 0
      ? `  ${
          summary.diagnostics.complete
            ? "First break"
            : "First break ON THIS PAGE"
        }: no stage was reached — grouped under ${categories.join(
          ", "
        )} (${grouped.length} of ${readable.length} measured ${measurementUnitLabel(
          "trial",
          readable.length
        )}${ungrouped > 0 ? `; ${ungrouped} established no category` : ""})`
      : undefined;
  }

  // Chain ORDER, not insertion order and not a sort: `USER_VALUE_STAGES` is
  // normative and "earliest" is defined by its positions.
  const stage = USER_VALUE_STAGES.find((candidate) => brokeAt.has(candidate))!;
  const stageLabel = labelFor(USER_VALUE_STAGE_LABELS, stage);
  if (stageLabel === undefined) return undefined;
  const row = readable
    .flatMap((item) =>
      item.chain.status === "verified" && item.chain.firstFailedStage === stage
        ? item.chain.stages.filter((entry) => entry.stage === stage)
        : []
    )
    .find((entry) => entry.reason !== undefined);
  const reason = labelFor(STAGE_REASON_LABELS, row?.reason);
  const because = reason ? ` — ${reason}` : "";
  // Said out loud whenever the breaks are spread, because "First break:
  // Connection (1 of 10)" reads as a connection problem to someone who does
  // not already know eight of the others stopped somewhere else.
  const spread =
    brokeAt.size > 1 ? `; earliest of ${brokeAt.size} stages that broke` : "";
  // A page is not the run. `complete` is false when trials went unexamined, and
  // one of them may have broken further up the chain.
  const scope = summary.diagnostics.complete
    ? "First break"
    : "First break ON THIS PAGE";
  // And whenever some chains could not be read at all, because otherwise the
  // denominator quietly shrinks to the trials that happened to validate and
  // "1 of 1" is read as "all of them".
  const withheld = items.length - readable.length;
  const unreadable =
    withheld > 0 ? `; ${withheld} more had no readable chain` : "";
  return (
    `  ${scope}: ${stageLabel}${because} ` +
    `(${brokeAt.get(stage)} of ${readable.length} measured ${unit}` +
    `${spread}${unreadable})`
  );
}

function formatDecisionHeadline(summary: EvalRunDecisionSummary): string {
  const verdict =
    labelFor(EVAL_RUN_DECISION_VERDICT_LABELS, summary.verdict) ?? "";
  const source =
    labelFor(EVAL_RUN_DECISION_VERDICT_SOURCE_LABELS, summary.verdictSource) ??
    "";
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
/**
 * One chain row: the stage, what it did, and why.
 *
 * Every value through the label maps. The five states stay five different
 * sentences — "we did not check", "it does not apply" and "it never ran" are
 * different facts, and one shared word for them is how "we never checked" gets
 * read as "it passed".
 */
function formatStageRow(row: StageResultRow): string {
  const state = labelFor(STAGE_STATE_LABELS, row.state) ?? "";
  const reason = labelFor(STAGE_REASON_LABELS, row.reason);
  // A `notReached` row's state already says "never ran (an earlier stage
  // failed)" and its reason says "an earlier stage failed" — the same sentence
  // twice on the four rows a reader sees most. Suppressed by CONTAINMENT
  // rather than by naming that pair, so a future state whose words absorb its
  // reason gets the same treatment without anyone remembering to add it.
  const because = reason && !state.includes(reason) ? ` — ${reason}` : "";
  return `${labelFor(USER_VALUE_STAGE_LABELS, row.stage) ?? ""}: ${state}${because}`;
}

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

function formatDecisionDiagnostic(
  item: EvalRunDecisionDiagnostic,
  options: FormatEvalRunDecisionSummaryOptions = {}
): string[] {
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
      const rowReason = labelFor(STAGE_REASON_LABELS, row?.reason);
      const because = rowReason ? ` — ${rowReason}` : "";
      lines.push(
        `    First failed stage: ${
          labelFor(USER_VALUE_STAGE_LABELS, stage) ?? ""
        }${because}`
      );
    } else {
      lines.push(
        "    First failed stage: none was established — the run never reached the server's stages"
      );
    }
    lines.push(
      labelFor(FAILURE_CATEGORY_LABELS, item.chain.failureCategory)
        ? `    Failure category: ${labelFor(
            FAILURE_CATEGORY_LABELS,
            item.chain.failureCategory
          )}`
        : "    Failure category: not reported"
    );
    // THE DETAILED LAYER, and only inside `verified`: the other two states have
    // no rows to print — one had its rows withheld for failing validation, the
    // other never had any. Printing six "not measured" rows for either would
    // state as measured-and-empty exactly what was never measured.
    if (options.stages) {
      lines.push("    Chain:");
      for (const row of item.chain.stages) {
        lines.push(`      ${formatStageRow(row)}`);
      }
    }
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
    const evidenceStage = labelFor(
      USER_VALUE_STAGE_LABELS,
      item.evidence.stage
    );
    const stage = evidenceStage ? ` at ${evidenceStage}` : "";
    lines.push(`    Evidence${stage}: ${evidence.join("; ")}`);
  }
  lines.push(`    Trace: ${item.evidence.tracePath}`);
  lines.push(`    Next action: ${item.nextAction}`);
  return lines;
}
