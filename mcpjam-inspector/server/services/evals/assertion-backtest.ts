import {
  hostedPredicateScoreDefinition,
  HOSTED_TOOL_ARGUMENTS_SCORER_ID,
  HOSTED_TOOL_MATCH_SCORER_ID,
} from "./score-definitions.js";
import { buildHostedScoreContract } from "./score-rows.js";
import { evaluateToolCalls, resolveMatchOptions } from "@mcpjam/sdk/matchers";
import {
  buildIterationTranscript,
  evaluatePredicates,
  predicateSchema,
  type Predicate,
} from "@mcpjam/sdk/predicates";
import {
  canonicalDigest,
  toolMatchScoreDefinition,
  TOOL_MATCH_SCORER_ID,
  fromToolMatchResult,
  definitionHash,
  resolveScoreDefinition,
  predicateScoreDefinition,
  scoreResultFromPredicateResult,
  toEvaluatorResult,
  scoreResultSchema,
  resolvedScoreDefinitionSchema,
  type ResolvedScoreDefinition,
  type ScoreResult,
} from "@mcpjam/sdk/contract";
import type {
  EvalBacktestDraft,
  EvalBacktestContinuation,
  EvalBacktestReport,
  EvalBacktestDifference,
} from "../../../../sdk/src/contract/eval-backtest.js";

type EvidenceRow = {
  iterationId: string;
  caseId: string;
  actualToolCalls?: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
  predicates?: unknown;
  expectedToolCalls?: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
  isNegativeTest?: boolean;
  results?: unknown;
  evaluationConfig?: unknown;
  evidence?: {
    traceVersion?: number;
    traceComplete?: boolean;
    messages?: Array<{ role: string; content: unknown }>;
    spans?: unknown[];
    widgetRenderObservations?: unknown[];
  } | null;
  completeness?: { transcript?: string; reason?: string };
};
export type BacktestEvidencePage = {
  schemaVersion: 1;
  sourceHash: string;
  runId: string;
  suiteId: string;
  configRevision?: unknown;
  reservationId: string;
  iterations: EvidenceRow[];
  isDone: boolean;
  cursor?: string;
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function originalResults(row: EvidenceRow): ScoreResult[] {
  return Array.isArray(row.results)
    ? row.results.flatMap((value) => {
        const parsed = scoreResultSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
}
function rulesFor(
  row: EvidenceRow,
  draft: EvalBacktestDraft,
): Predicate[] | null {
  if (draft.assertions.mode === "replace") return draft.assertions.list;
  const original = Array.isArray(row.predicates)
    ? row.predicates
    : record(row.predicates) && Array.isArray(row.predicates.list)
    ? row.predicates.list
    : null;
  if (!original || original.length + draft.assertions.list.length > 100)
    return null;
  const rules: Predicate[] = [];
  for (const rule of original) {
    const parsed = predicateSchema.safeParse(rule);
    if (!parsed.success) return null;
    rules.push(parsed.data as Predicate);
  }
  return draft.assertions.mode === "extend"
    ? [...rules, ...draft.assertions.list]
    : rules;
}
/** One context from frozen evidence, shared by every draft assertion on this iteration. */
export function backtestIteration(
  row: EvidenceRow,
  draft: EvalBacktestDraft,
): EvalBacktestDifference[] {
  const rules = rulesFor(row, draft);
  const stored = originalResults(row);
  if (!rules)
    return [
      {
        iterationId: row.iterationId,
        caseId: row.caseId,
        evaluatorId: "assertions",
        change: "unchanged",
        comparable: false,
        reason: "Frozen assertion configuration is unavailable",
      },
    ];
  const evidence = row.evidence;
  const missing =
    evidence?.traceVersion !== 1
      ? "Unsupported or unavailable evidence version"
      : row.completeness?.transcript !== "complete" ||
        evidence.traceComplete !== true
      ? "Transcript capture is incomplete"
      : !Array.isArray(row.actualToolCalls)
      ? "Tool call capture is unavailable"
      : undefined;
  const transcript = buildIterationTranscript({
    toolCalls: row.actualToolCalls ?? [],
    trace: { messages: evidence?.messages ?? [] },
  });
  const evaluated = missing ? [] : evaluatePredicates(transcript, rules);
  const definitions =
    record(row.evaluationConfig) &&
    Array.isArray(row.evaluationConfig.definitions)
      ? row.evaluationConfig.definitions.flatMap((value) => {
          const parsed = resolvedScoreDefinitionSchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  const hosted = definitions.some(
    (definition) =>
      definition.idSource === "platform" &&
      (definition.scorerId.startsWith("predicate:") ||
        definition.scorerId === HOSTED_TOOL_MATCH_SCORER_ID ||
        definition.scorerId === HOSTED_TOOL_ARGUMENTS_SCORER_ID),
  );
  const seen = new Set<string>();
  const differences: EvalBacktestDifference[] = rules.map((rule, index) => {
    const definition = resolveScoreDefinition(
      hosted
        ? hostedPredicateScoreDefinition({ predicate: rule })
        : predicateScoreDefinition(rule, { ordinal: index }),
    );
    const priorDefinition = definitions.find(
      (item) => item.scorerId === definition.scorerId,
    );
    const previous = stored.find(
      (item) =>
        item.scorerId === definition.scorerId &&
        item.definitionHash ===
          (priorDefinition ? definitionHash(priorDefinition) : undefined),
    );
    seen.add(definition.scorerId);
    const unavailable =
      missing ??
      (rule.type.startsWith("widget")
        ? "Render observation compatibility was not established"
        : rule.type === "tokenBudgetUnder"
        ? "Token usage was not captured in the backtest evidence"
        : (rule.type.startsWith("response") ||
            rule.type === "finalAssistantMessageNonEmpty" ||
            rule.type === "noEndingQuestion") &&
          transcript.finalAssistantMessage === undefined
        ? "Final assistant text was not captured"
        : undefined);
    const next =
      !unavailable && evaluated[index]
        ? toEvaluatorResult(
            scoreResultFromPredicateResult(definition, evaluated[index]),
          )
        : undefined;
    const old = previous ? toEvaluatorResult(previous) : undefined;
    const comparable =
      !!old && !!next && old.status === "scored" && next.status === "scored";
    return {
      iterationId: row.iterationId,
      caseId: row.caseId,
      evaluatorId: definition.scorerId,
      change: !priorDefinition
        ? "added"
        : definitionHash(priorDefinition) === definitionHash(definition)
        ? "unchanged"
        : "configuration_changed",
      comparable,
      ...(old ? { stored: old } : {}),
      ...(next ? { draft: next } : {}),
      ...(comparable
        ? { flipped: old!.passed !== next!.passed }
        : {
            reason:
              unavailable ??
              (!old
                ? "Original evaluator observation is unavailable"
                : next?.error ?? "Required evidence was not captured"),
          }),
    };
  });
  if (draft.matchOptions) {
    differences.push(
      ...(hosted
        ? hostedToolCallDifferences(row, draft.matchOptions, {
            missing,
            definitions,
            stored,
            seen,
          })
        : sdkToolMatchDifferences(row, draft.matchOptions, {
            missing,
            definitions,
            stored,
            seen,
          })),
    );
  }
  for (const definition of definitions) {
    if (seen.has(definition.scorerId)) continue;
    const previous = stored.find(
      (item) => item.definitionHash === definitionHash(definition),
    );
    differences.push({
      iterationId: row.iterationId,
      caseId: row.caseId,
      evaluatorId: definition.scorerId,
      change: "removed",
      comparable: false,
      reason: "Evaluator is outside this assertion-only draft",
      ...(previous ? { stored: toEvaluatorResult(previous) } : {}),
    });
  }
  return differences;
}

type ToolCallBacktestContext = {
  missing: string | undefined;
  definitions: ResolvedScoreDefinition[];
  stored: ScoreResult[];
  seen: Set<string>;
};

function frozenToolEvidenceMissing(
  row: EvidenceRow,
  missing: string | undefined,
): string | undefined {
  return (
    missing ??
    (!Array.isArray(row.expectedToolCalls) ||
    typeof row.isNegativeTest !== "boolean"
      ? "Frozen tool expectations or test polarity are unavailable"
      : undefined)
  );
}

/** One matcher-backed evaluator's difference, stored result against draft. */
function toolCallDifference(
  row: EvidenceRow,
  context: ToolCallBacktestContext,
  evaluatorId: string,
  next:
    | { definition: ResolvedScoreDefinition; result: ScoreResult }
    | { unavailable: string },
): EvalBacktestDifference {
  context.seen.add(evaluatorId);
  const prior = context.definitions.find(
    (item) => item.scorerId === evaluatorId,
  );
  const old = context.stored.find(
    (item) =>
      item.scorerId === evaluatorId &&
      prior &&
      item.definitionHash === definitionHash(prior),
  );
  if ("unavailable" in next) {
    return {
      iterationId: row.iterationId,
      caseId: row.caseId,
      evaluatorId,
      change: prior ? "configuration_changed" : "added",
      comparable: false,
      reason: next.unavailable,
      ...(old ? { stored: toEvaluatorResult(old) } : {}),
    };
  }
  const draftResult = toEvaluatorResult(next.result);
  // A stored row graded by an earlier version of the evaluator answered a
  // different question: `toolCalls:match` v2 is the matcher's whole verdict,
  // arguments included, where v3 is selection only. Compared, every iteration
  // that failed only on arguments would read as a fail → pass flip the draft
  // did not cause, on every run graded before the split.
  const earlierVersion =
    !!old && !!prior && prior.scorerVersion !== next.definition.scorerVersion;
  const comparable = old?.status === "scored" && !earlierVersion;
  return {
    iterationId: row.iterationId,
    caseId: row.caseId,
    evaluatorId,
    change: !prior
      ? "added"
      : definitionHash(prior) === definitionHash(next.definition)
      ? "unchanged"
      : "configuration_changed",
    comparable,
    draft: draftResult,
    ...(old ? { stored: toEvaluatorResult(old) } : {}),
    ...(comparable
      ? { flipped: toEvaluatorResult(old!).passed !== draftResult.passed }
      : {
          reason: earlierVersion
            ? "Graded by an earlier version of this evaluator"
            : "Original matcher observation is unavailable",
        }),
  };
}

/**
 * A hosted run grades tool calls with TWO scorers since the split: which tools
 * (`toolCalls:match`) and how (`toolCalls:arguments`). Both are rebuilt here
 * through the runner's projection (`buildHostedScoreContract`), so a stored
 * arguments definition is never reported as removed by a draft that changes
 * the match options it depends on.
 *
 * The projection is the runner's; its INPUT is not quite. The evidence page
 * carries the frozen expectations and the actual calls flattened across turns,
 * with no turn boundaries, so the extras cap (`maxExtraToolCalls`) applies to
 * the whole run here where the runner applies it per turn. On a multi-turn
 * case with a cap the two can disagree about selection.
 */
function hostedToolCallDifferences(
  row: EvidenceRow,
  draftMatchOptions: NonNullable<EvalBacktestDraft["matchOptions"]>,
  context: ToolCallBacktestContext,
): EvalBacktestDifference[] {
  const matchOptions = resolveMatchOptions(draftMatchOptions);
  const unavailable = frozenToolEvidenceMissing(row, context.missing);
  if (unavailable) {
    const ids = [
      HOSTED_TOOL_MATCH_SCORER_ID,
      ...(matchOptions.argumentMatching !== "ignore" &&
      row.isNegativeTest !== true
        ? [HOSTED_TOOL_ARGUMENTS_SCORER_ID]
        : []),
    ];
    return ids.map((id) =>
      toolCallDifference(row, context, id, { unavailable }),
    );
  }
  const expected = row.expectedToolCalls ?? [];
  const result = evaluateToolCalls(expected, row.actualToolCalls ?? [], {
    ...matchOptions,
    isNegativeTest: row.isNegativeTest,
  });
  const contract = buildHostedScoreContract({
    // Declared from the frozen case, as the runner declares it.
    toolMatchAuthored: true,
    evaluation: {
      passed: result.passed,
      expectedToolCalls: expected,
      missing: result.missing,
      unexpected: result.extra,
      argumentMismatches: result.argumentMismatches,
    },
    matchOptions: matchOptions as unknown as Record<string, unknown>,
    ...(row.isNegativeTest ? { isNegativeTest: true } : {}),
  });
  return contract.evaluationConfig.definitions.flatMap((definition) => {
    const scored = contract.scores.find(
      (score) => score.scorerId === definition.scorerId,
    );
    return scored
      ? [
          toolCallDifference(row, context, definition.scorerId, {
            definition,
            result: scored,
          }),
        ]
      : [];
  });
}

/** The SDK's single `tool-match` scorer, which the split does not touch. */
function sdkToolMatchDifferences(
  row: EvidenceRow,
  draftMatchOptions: NonNullable<EvalBacktestDraft["matchOptions"]>,
  context: ToolCallBacktestContext,
): EvalBacktestDifference[] {
  const unavailable = frozenToolEvidenceMissing(row, context.missing);
  if (unavailable) {
    return [
      toolCallDifference(row, context, TOOL_MATCH_SCORER_ID, { unavailable }),
    ];
  }
  const matchOptions = resolveMatchOptions(draftMatchOptions);
  const definition = resolveScoreDefinition(
    toolMatchScoreDefinition({
      expectedToolCalls: row.expectedToolCalls!,
      matchOptions,
      isNegativeTest: row.isNegativeTest,
    }),
  );
  return [
    toolCallDifference(row, context, TOOL_MATCH_SCORER_ID, {
      definition,
      result: fromToolMatchResult(
        definition,
        evaluateToolCalls(row.expectedToolCalls!, row.actualToolCalls ?? [], {
          ...matchOptions,
          isNegativeTest: row.isNegativeTest,
        }),
      ),
    }),
  ];
}

export async function runAssertionBacktest(input: {
  runId: string;
  suiteId: string;
  draft: EvalBacktestDraft;
  continuation?: EvalBacktestContinuation;
  readPage: (args: Record<string, unknown>) => Promise<BacktestEvidencePage>;
  signal?: AbortSignal;
}): Promise<EvalBacktestReport> {
  const deadline = Date.now() + 30_000;
  const draft: EvalBacktestDraft = JSON.parse(JSON.stringify(input.draft));
  const draftHash = canonicalDigest(draft);
  if (input.continuation && input.continuation.draftHash !== draftHash)
    throw new Error("EVAL_BACKTEST_SOURCE_CHANGED");
  const differences: EvalBacktestDifference[] = [];
  const seen = new Set<string>();
  let page: BacktestEvidencePage | undefined;
  let count = 0;
  for (let n = 0; n < 10; n++) {
    if (input.signal?.aborted) throw new Error("Backtest cancelled");
    const priorPage = page;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("Backtest cancelled"));
      input.signal?.addEventListener("abort", cancel, { once: true });
    });
    try {
      page = await Promise.race([
        cancelled,
        input.readPage({
          suiteId: input.suiteId,
          runId: input.runId,
          pageSize: 10,
          ...(page
            ? {
                cursor: page.cursor,
                sourceHash: page.sourceHash,
                reservationId: page.reservationId,
              }
            : input.continuation
            ? {
                cursor: input.continuation.cursor,
                sourceHash: input.continuation.sourceHash,
                reservationId: input.continuation.reservationId,
              }
            : {}),
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Backtest deadline exceeded")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      if (cancel) input.signal?.removeEventListener("abort", cancel);
    }
    if (
      page.sourceHash !==
      (priorPage?.sourceHash ??
        input.continuation?.sourceHash ??
        page.sourceHash)
    )
      throw new Error("EVAL_BACKTEST_SOURCE_CHANGED");
    if (page.iterations?.length > 10)
      throw new Error("Backtest evidence page exceeded its row limit");
    if (
      page.schemaVersion !== 1 ||
      page.runId !== input.runId ||
      page.suiteId !== input.suiteId ||
      typeof page.sourceHash !== "string" ||
      !page.sourceHash ||
      typeof page.reservationId !== "string" ||
      !page.reservationId ||
      typeof page.isDone !== "boolean" ||
      !Array.isArray(page.iterations)
    )
      throw new Error("Invalid backtest evidence response");
    for (const row of page.iterations) {
      if (!row.iterationId || seen.has(row.iterationId))
        throw new Error("Duplicate or invalid backtest iteration identity");
      seen.add(row.iterationId);
      differences.push(...backtestIteration(row, draft));
      count++;
      if (Date.now() > deadline) throw new Error("Backtest deadline exceeded");
    }
    if (page.isDone) break;
    if (!page.cursor) throw new Error("Backtest evidence cursor was missing");
  }
  const comparable = differences.filter((row) => row.comparable).length;
  return {
    schemaVersion: 1,
    sourceRunId: input.runId,
    sourceHash: page!.sourceHash,
    draftHash,
    configRevision: page!.configRevision,
    complete:
      page!.isDone &&
      count > 0 &&
      differences.length > 0 &&
      comparable === differences.length,
    continuationAvailable: !page!.isDone,
    ...(!page!.isDone
      ? {
          continuation: {
            cursor: page!.cursor!,
            sourceHash: page!.sourceHash,
            reservationId: page!.reservationId,
            draftHash,
          },
        }
      : {}),
    counts: {
      iterations: count,
      comparable,
      ungradable: differences.length - comparable,
      flipped: differences.filter((row) => row.flipped).length,
    },
    differences,
    modelUse: "none",
  };
}
