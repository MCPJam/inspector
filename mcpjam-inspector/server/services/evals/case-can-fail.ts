/**
 * "Can this case fail?" for a stored or about-to-be-stored case.
 *
 * The verdict itself is `checkCaseCanFail` (`@mcpjam/sdk/predicates`): grade
 * the case's checks against an empty answer. This module only feeds it the
 * case as the runner would grade it — the EFFECTIVE case-level checks (suite
 * defaults merged with the case's envelope, exactly as `recorder.ts` and the
 * single-case run resolve them), the tool-call expectations and per-turn
 * checks its steps project to, the goal-completion judge's role, and the
 * gating work the predicate engine does not see (pinned calls, widget checks),
 * which can only be "can't tell".
 *
 * Surfaced without new UI: a `warnings[]` entry on case create/update
 * responses, the run's `vacuousCaseIds` at start (read by run insights), and a
 * refusal of a trace-repair candidate. A warning never blocks a save.
 */
import {
  checkCaseCanFail,
  type CaseCanFailResult,
  type Predicate,
} from "@mcpjam/sdk/predicates";
import {
  resolveCaseSuccessPredicates,
  type CasePredicates,
} from "@/shared/eval-matching";
import { resolveCasePromptTurns } from "@/shared/steps";
import { logger } from "../../utils/logger.js";

/**
 * The authoring-lint code and message. MIRRORED, word for word, by
 * `convex/lib/testCaseAuthoringLints.ts` in mcpjam-backend (pinned by its
 * `check:mirrors`), so a case reads the same in an API response, in run
 * insights and in a refused trace-repair candidate.
 */
export const CASE_PASSES_WITH_EMPTY_ANSWER = "case_passes_with_empty_answer";
export const CASE_PASSES_WITH_EMPTY_ANSWER_MESSAGE =
  "This case passes when the agent does nothing: every gating check passes on an empty answer, so it can never fail. Add an expected tool call or a check an empty answer fails (for example a response check).";

export interface CaseAuthoringWarning {
  code: string;
  message: string;
}

/**
 * The case fields the verdict reads, as Convex stores (and takes) them. Open:
 * a stored row and a write's args carry many more fields, all ignored here.
 */
export type CaseCanFailCase = {
  [field: string]: unknown;
  steps?: unknown;
  query?: unknown;
  expectedToolCalls?: unknown;
  expectedOutput?: unknown;
  advancedConfig?: unknown;
  promptTurns?: unknown;
  isNegativeTest?: unknown;
  /** The case's `{ mode, list }` check envelope. */
  predicates?: unknown;
  /** Pre-envelope flat check list. */
  successPredicates?: unknown;
  suppressedSuiteStandardCheckIds?: unknown;
  /** Per-case judge opt-out (`{ goalCompletion: { enabled } }`). */
  judgeConfigOverride?: unknown;
};

/** Read a suite doc's default checks; anything else is "none". */
export function suiteDefaultPredicatesOf(
  suite: unknown,
): Predicate[] | undefined {
  const defaults = (suite as { defaultPredicates?: unknown } | null)
    ?.defaultPredicates;
  return Array.isArray(defaults) && defaults.length > 0
    ? (defaults as Predicate[])
    : undefined;
}

/**
 * The case-level checks live grading applies: suite defaults resolved against
 * the case's envelope (or its legacy list), minus suppressed standard checks.
 */
export function resolveEffectiveCasePredicates(
  testCase: CaseCanFailCase,
  suite: unknown,
): Predicate[] | undefined {
  return resolveCaseSuccessPredicates({
    suiteDefaults: suiteDefaultPredicatesOf(suite),
    suppressedSuiteStandardCheckIds: Array.isArray(
      testCase.suppressedSuiteStandardCheckIds,
    )
      ? (testCase.suppressedSuiteStandardCheckIds as string[])
      : undefined,
    envelope: (testCase.predicates ?? undefined) as CasePredicates | undefined,
    legacyCase: Array.isArray(testCase.successPredicates)
      ? (testCase.successPredicates as Predicate[])
      : undefined,
  });
}

/**
 * The goal-completion judge role that grades this case, or `undefined` when
 * no judge runs for it: the suite's setting (enabled by default, advisory by
 * default) with the case's opt-out layered on, as the backend's
 * `resolveGoalCompletionConfig` layers them.
 */
export function goalCompletionJudgeRoleOf(
  testCase: CaseCanFailCase,
  suite: unknown,
): unknown {
  const suiteSlot = (
    suite as {
      judgeConfig?: { goalCompletion?: { enabled?: unknown; role?: unknown } };
    } | null
  )?.judgeConfig?.goalCompletion;
  const caseSlot = (
    testCase.judgeConfigOverride as
      | { goalCompletion?: { enabled?: unknown } }
      | undefined
  )?.goalCompletion;
  const enabled =
    typeof caseSlot?.enabled === "boolean"
      ? caseSlot.enabled
      : suiteSlot?.enabled !== false;
  return enabled ? (suiteSlot?.role ?? "advisory") : undefined;
}

/**
 * Grade a case against an empty answer.
 *
 * `suite` supplies the default checks and the judge setting. Pass
 * `effectivePredicates` when the caller already holds the exact list it will
 * grade with (a run's frozen resolver, trace-repair verification).
 */
export function checkStoredCaseCanFail(
  testCase: CaseCanFailCase,
  suite: unknown,
  options: { effectivePredicates?: Predicate[] } = {},
): CaseCanFailResult {
  const turns = resolveCasePromptTurns({
    steps: testCase.steps,
    promptTurns: testCase.promptTurns,
    advancedConfig: testCase.advancedConfig,
    query: typeof testCase.query === "string" ? testCase.query : undefined,
    expectedToolCalls: testCase.expectedToolCalls,
    expectedOutput:
      typeof testCase.expectedOutput === "string"
        ? testCase.expectedOutput
        : undefined,
  });
  const externalChecks: string[] = [];
  turns.forEach((turn, index) => {
    if (turn.pinnedToolCall) {
      externalChecks.push(
        `pinned call ${turn.pinnedToolCall.toolName} (turn ${index + 1})`,
      );
    }
    for (const group of turn.widgetChecks ?? []) {
      externalChecks.push(
        `widget checks on ${group.toolName} (turn ${index + 1})`,
      );
    }
  });
  return checkCaseCanFail(
    options.effectivePredicates ??
      resolveEffectiveCasePredicates(testCase, suite),
    turns.flatMap((turn) => turn.expectedToolCalls),
    testCase.isNegativeTest === true,
    {
      turnChecks: turns.map((turn, promptIndex) => ({
        promptIndex,
        checks: turn.checks,
      })),
      externalChecks,
      goalCompletionJudgeRole: goalCompletionJudgeRoleOf(testCase, suite),
      userTurns: Math.max(1, turns.filter((t) => !t.pinnedToolCall).length),
    },
  );
}

/**
 * The authoring warnings for one case write, or none. Best effort by
 * contract: a case that cannot be read as a runner would read it gets no
 * warning rather than a failed save, and so does a case whose suite could not
 * be read — its default checks and judge decide the verdict.
 */
export function caseAuthoringWarnings(
  testCase: CaseCanFailCase | null | undefined,
  suite: unknown,
): CaseAuthoringWarning[] {
  if (!testCase || !suite) return [];
  try {
    return checkStoredCaseCanFail(testCase, suite).vacuous
      ? [
          {
            code: CASE_PASSES_WITH_EMPTY_ANSWER,
            message: CASE_PASSES_WITH_EMPTY_ANSWER_MESSAGE,
          },
        ]
      : [];
  } catch {
    return [];
  }
}

/**
 * A batch write's result with each committed case's authoring warnings
 * appended to its own `warnings`. The batch contract already carries
 * per-entry warnings, so this adds an entry, never a new field. Every batch
 * write path goes through here.
 */
export function withCaseAuthoringWarnings<
  T extends {
    committed: Array<{ index: number; warnings?: CaseAuthoringWarning[] }>;
  },
>(
  result: T,
  items: ReadonlyArray<CaseCanFailCase | undefined>,
  suite: unknown,
): T {
  return {
    ...result,
    committed: result.committed.map((entry) => {
      const added = caseAuthoringWarnings(items[entry.index], suite);
      return added.length > 0
        ? { ...entry, warnings: [...(entry.warnings ?? []), ...added] }
        : entry;
    }),
  };
}

/**
 * At run start, record which of the run's cases can never fail, so run
 * insights can name them (`testSuites:recordRunVacuousCases`). The run grades
 * exactly as it would without this; a failure to record is logged, never
 * raised — a missing lint must not cost a run.
 *
 * `resolvePredicates` is the run's own resolver (the recorder's
 * `resolvePredicatesForCase`), so the verdict reads the suite defaults this
 * run froze. `suite` supplies the judge setting; without it the judge's role
 * is unknown, and nothing is recorded rather than guessed.
 */
export async function recordRunVacuousCases(
  convexClient: { mutation: (name: any, args: any) => Promise<unknown> },
  runId: string,
  testCases: ReadonlyArray<Record<string, any>>,
  resolvePredicates: (tc: Record<string, any>) => Predicate[] | undefined,
  suite: unknown,
): Promise<string[]> {
  if (!suite) return [];
  const vacuousCaseIds: string[] = [];
  for (const tc of testCases) {
    const testCaseId = tc?._id ?? tc?.testCaseId;
    if (typeof testCaseId !== "string") continue;
    try {
      const result = checkStoredCaseCanFail(tc, suite, {
        effectivePredicates: resolvePredicates(tc) ?? [],
      });
      if (result.vacuous) vacuousCaseIds.push(testCaseId);
    } catch {
      // A case the lint cannot read is not reported either way.
    }
  }
  // Nothing to say is said by not writing: most runs pay no extra round trip.
  if (vacuousCaseIds.length === 0) return vacuousCaseIds;
  try {
    await convexClient.mutation("testSuites:recordRunVacuousCases" as any, {
      runId,
      testCaseIds: [...new Set(vacuousCaseIds)],
    });
  } catch (error) {
    logger.warn("[evals] Failed to record vacuous cases at run start", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return vacuousCaseIds;
}
