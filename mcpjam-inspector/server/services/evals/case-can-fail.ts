/**
 * "Can this case fail?" for a stored or about-to-be-stored case.
 *
 * The verdict itself is `checkCaseCanFail` (`@mcpjam/sdk/predicates`): grade
 * the case's checks against an empty answer. This module only feeds it the
 * case as the runner would grade it — the EFFECTIVE case-level checks (suite
 * defaults merged with the case's envelope, exactly as `recorder.ts` and the
 * single-case run resolve them), the tool-call expectations and per-turn
 * checks its steps project to, and the gating work the predicate engine does
 * not see (pinned calls, widget checks), which can only be "can't tell".
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

/** Mirrors the backend authoring-lint code (`lib/testCaseAuthoringLints.ts`). */
export const CASE_PASSES_WITH_EMPTY_ANSWER = "case_passes_with_empty_answer";

/**
 * `MCPJAM_TRACE_REPAIR_VACUOUS_GUARD` — trace repair REFUSES a rewrite that
 * passes on an empty answer when `on`. Off by default: the check still runs
 * and logs `trace_repair.vacuous_candidate` (shadow), so the rate can be
 * measured before the refusal ships.
 */
export function traceRepairVacuousGuardEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ["1", "true", "on", "yes"].includes(
    (env.MCPJAM_TRACE_REPAIR_VACUOUS_GUARD ?? "").trim().toLowerCase(),
  );
}

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
};

/**
 * The case-level checks live grading applies: suite defaults resolved against
 * the case's envelope (or its legacy list), minus suppressed standard checks.
 */
export function resolveEffectiveCasePredicates(
  testCase: CaseCanFailCase,
  suiteDefaultPredicates: readonly Predicate[] | undefined,
): Predicate[] | undefined {
  return resolveCaseSuccessPredicates({
    suiteDefaults:
      suiteDefaultPredicates && suiteDefaultPredicates.length > 0
        ? [...suiteDefaultPredicates]
        : undefined,
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
 * Grade a case against an empty answer.
 *
 * `effectivePredicates` overrides the resolution when the caller already has
 * the exact list it will grade with (trace-repair verification does).
 */
export function checkStoredCaseCanFail(
  testCase: CaseCanFailCase,
  suiteDefaultPredicates: readonly Predicate[] | undefined,
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
      resolveEffectiveCasePredicates(testCase, suiteDefaultPredicates),
    turns.flatMap((turn) => turn.expectedToolCalls),
    testCase.isNegativeTest === true,
    {
      turnChecks: turns.map((turn, promptIndex) => ({
        promptIndex,
        checks: turn.checks,
      })),
      externalChecks,
      userTurns: Math.max(1, turns.filter((t) => !t.pinnedToolCall).length),
    },
  );
}

/** The authoring warning for a vacuous case, or none. */
export function caseCanFailWarnings(
  result: CaseCanFailResult,
): CaseAuthoringWarning[] {
  if (!result.vacuous) return [];
  return [
    {
      code: CASE_PASSES_WITH_EMPTY_ANSWER,
      message:
        `This case passes when the agent does nothing: ${result.reason}. ` +
        "Add an expected tool call or a check an empty answer fails.",
    },
  ];
}

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
 * Warnings for a case write. Best effort by contract: a case that cannot be
 * read as a runner would read it gets no warning rather than a failed save.
 */
export function caseAuthoringWarnings(
  testCase: CaseCanFailCase | null | undefined,
  suite: unknown,
): CaseAuthoringWarning[] {
  if (!testCase) return [];
  try {
    return caseCanFailWarnings(
      checkStoredCaseCanFail(testCase, suiteDefaultPredicatesOf(suite)),
    );
  } catch {
    return [];
  }
}

/**
 * A batch write's result with each committed case's can-it-fail warning
 * appended to its own `warnings`. The batch contract already carries
 * per-entry warnings, so this adds an entry, never a new field.
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
 * run froze rather than the live suite.
 */
export async function recordRunVacuousCases(
  convexClient: { mutation: (name: any, args: any) => Promise<unknown> },
  runId: string,
  testCases: ReadonlyArray<Record<string, any>>,
  resolvePredicates: (tc: Record<string, any>) => Predicate[] | undefined,
): Promise<string[]> {
  const vacuousCaseIds: string[] = [];
  for (const tc of testCases) {
    const testCaseId = tc?._id ?? tc?.testCaseId;
    if (typeof testCaseId !== "string") continue;
    try {
      const result = checkStoredCaseCanFail(tc, undefined, {
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
