/**
 * The canonical **eval run route facts** — one versioned shape that says
 * which tool paths a run's trials took, and which expected tools were
 * missing or substituted, without deciding a verdict.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * Embeddings navigate and compress eval evidence; they never measure
 * reliability, decide verdicts, or explain causality. Selection failures
 * have no dominant shape, so this contract states per-tool facts with an
 * opportunity denominator and says "substitution" only for the one-to-one
 * shape (exactly one expected name missing and exactly one unexpected
 * in-catalog name observed). Cosine similarity is not a diagnostic.
 *
 * ── It REPORTS; it never DECIDES ─────────────────────────────────────────────
 *
 * Nothing here writes `result`, feeds a gate, or changes a verdict. Every
 * rate is an {@link EvalRateMeasurement} envelope over the trial population,
 * with exclusions drawn from {@link EVAL_TRIAL_EXCLUSION_REASONS}. A missing
 * document is UNMEASURED, never zero.
 *
 * ── Counting rules ───────────────────────────────────────────────────────────
 *
 *   - Included = terminal graded trials (`status === "completed"` and not
 *     an evaluator error). `status === "failed"` is `executionFailed`.
 *   - Passed iff `result === "passed"`. A completed trial with no result
 *     is a failed observation, not an exclusion.
 *   - Name-level only: an expected tool called with wrong args counts as
 *     called. Argument mismatches stay with the matcher.
 *   - Substitution only when exactly one expected name is missing AND
 *     exactly one unexpected name is observed AND that tool is `inCatalog`.
 *   - Negative tests enter route facts and never enter mismatch facts.
 *   - `endedWithQuestion` counts only trials where the boolean was
 *     supplied, so it stays `notMeasured` until a producer exists.
 *   - Deterministic: cases sorted by `caseVariantKey`, routes by trials
 *     desc then `pathKey`, tools by name. `now` is passed in; nothing
 *     here reads the clock.
 *
 * ── No `.default()`, every object `.strict()` ────────────────────────────────
 *
 * Same discipline as `./verdict-policy.ts` and `./decision-summary.ts`: an
 * omitted field stays omitted so the payload is byte-stable, and an unknown
 * field is an error rather than a silent passenger.
 */

import { z } from "zod";
import { EVAL_RUN_MEASUREMENT_UNITS } from "./decision-summary.js";
import {
  evalStageAnalyticsMaterializationStateSchema,
  type EvalStageAnalyticsMaterializationState,
} from "./stage-analytics.js";
import {
  EVAL_TRIAL_EXCLUSION_REASONS,
  MAX_EVAL_CASE_AGGREGATIONS,
  evalExecutionVariantSchema,
  evalRateMeasurementSchema,
  evalRateMeasurementStructuralSchema,
  evalTrialExclusionsSchema,
  type EvalExecutionVariant,
  type EvalRateMeasurement,
  type EvalTrialExclusionReason,
  type EvalTrialExclusions,
} from "./verdict-policy.js";
import { buildPathKey } from "./tool-path.js";
// The path helpers are the contract's shared `tool-path` module; re-exported
// here so a caller that imports the route-facts module directly sees the
// same names the route facts are built from.
export {
  NO_TOOL_PATH_KEY,
  PATH_SEPARATOR,
  buildPathKey,
  collapseImmediateRepeats,
} from "./tool-path.js";

/**
 * The contract version, as a literal.
 *
 * `1` because this shape has no predecessor on the wire.
 */
export const EVAL_RUN_ROUTE_FACTS_SCHEMA_VERSION = 1;
export type EvalRunRouteFactsSchemaVersion =
  typeof EVAL_RUN_ROUTE_FACTS_SCHEMA_VERSION;

/** The `$id` of the published JSON Schema for this contract. */
export const EVAL_RUN_ROUTE_FACTS_SCHEMA_ID =
  "https://mcpjam.com/schemas/eval-run-route-facts/v1.json";

/**
 * Derivation semantics version. Bump when a counting rule changes, even if
 * the document shape stays the same — a reader that compared two rows
 * produced under different counting rules would be comparing different
 * facts under the same field names.
 */
export const ROUTE_FACTS_VERSION = 1;
export type RouteFactsVersion = typeof ROUTE_FACTS_VERSION;

const countSchema = z.number().int().min(0);

// ── ported trajectory constants ──────────────────────────────────────────────

/** Same-tool repetition count at or above which a trial is tagged `looping`. */
export const ROUTE_LOOPING_THRESHOLD = 3;

/**
 * Cap on the retained ordered tool-name sequence. One pathological loop
 * cannot write an unbounded array.
 */
export const MAX_ROUTE_TOOL_CALLS = 200;

/** Distinct routes retained per case; the tail folds into `otherRoutes`. */
export const MAX_ROUTES_PER_CASE = 24;

/** Distinct tools retained on a measured mismatch block. */
export const MAX_MISMATCH_TOOLS = 64;

// ── closed vocabularies ──────────────────────────────────────────────────────

export const EVAL_ROUTE_TAGS = ["noToolCalled", "retried", "looping"] as const;
export type EvalRouteTag = (typeof EVAL_ROUTE_TAGS)[number];
export const evalRouteTagSchema = z.enum(EVAL_ROUTE_TAGS);
export function isEvalRouteTag(value: unknown): value is EvalRouteTag {
  return (
    typeof value === "string" &&
    (EVAL_ROUTE_TAGS as readonly string[]).includes(value)
  );
}

export const EVAL_ROUTE_CATALOG_STATES = ["loaded", "notLoaded"] as const;
export type EvalRouteCatalogState = (typeof EVAL_ROUTE_CATALOG_STATES)[number];
export const evalRouteCatalogStateSchema = z.enum(EVAL_ROUTE_CATALOG_STATES);
export function isEvalRouteCatalogState(
  value: unknown
): value is EvalRouteCatalogState {
  return (
    typeof value === "string" &&
    (EVAL_ROUTE_CATALOG_STATES as readonly string[]).includes(value)
  );
}

export const EVAL_TOOL_CATALOG_MEMBERSHIPS = [
  "inCatalog",
  "outsideCatalog",
  "catalogNotLoaded",
] as const;
export type EvalToolCatalogMembership =
  (typeof EVAL_TOOL_CATALOG_MEMBERSHIPS)[number];
export const evalToolCatalogMembershipSchema = z.enum(
  EVAL_TOOL_CATALOG_MEMBERSHIPS
);
export function isEvalToolCatalogMembership(
  value: unknown
): value is EvalToolCatalogMembership {
  return (
    typeof value === "string" &&
    (EVAL_TOOL_CATALOG_MEMBERSHIPS as readonly string[]).includes(value)
  );
}

export const EVAL_ROUTE_MISMATCH_STATES = [
  "measured",
  "excludedNegativeTest",
  "notMeasured",
] as const;
export type EvalRouteMismatchState =
  (typeof EVAL_ROUTE_MISMATCH_STATES)[number];
export const evalRouteMismatchStateSchema = z.enum(EVAL_ROUTE_MISMATCH_STATES);

// ── inputs ───────────────────────────────────────────────────────────────────

export type RouteFactsTrialInput = {
  trialKey: string;
  status: string;
  result?: string;
  actualToolCalls: readonly unknown[];
  expectedToolCalls: readonly unknown[];
  isNegativeTest?: boolean;
  evaluatorErrored?: boolean;
  caseVariantKey: string;
  caseKey?: string;
  executionVariant?: EvalExecutionVariant;
  endedWithQuestion?: boolean;
};

export type RouteFactsCatalog =
  | { state: "loaded"; toolNames: readonly string[]; hash?: string }
  | { state: "notLoaded" };

export type RouteFactsRunInput = {
  runId: string;
  suiteId: string;
  runGroupId?: string;
  configRevision?: string;
  runCompletedAt?: number;
  sourceMaxUpdatedAt?: number;
  materializationState: EvalStageAnalyticsMaterializationState;
  now: number;
  createdAt?: number;
};

export type RouteFactsInput = {
  run: RouteFactsRunInput;
  trials: readonly RouteFactsTrialInput[];
  catalog: RouteFactsCatalog;
};

// ── helpers ──────────────────────────────────────────────────────────────────

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read a tool name from a call-shaped record, order-preserving.
 *
 * `toolName ?? tool ?? name`. This is NOT `decision-summary.ts` `toolNames()`,
 * which dedupes into a Set and drops order — a path cannot be recovered
 * from a set.
 */
export function readToolName(call: unknown): string | undefined {
  if (!call || typeof call !== "object") return undefined;
  const record = call as Record<string, unknown>;
  return (
    nonEmptyString(record.toolName) ??
    nonEmptyString(record.tool) ??
    nonEmptyString(record.name)
  );
}

export type DerivedTrialRoute = {
  pathKey: string;
  toolCallSequence: string[];
  retryCount: number;
  distinctToolCount: number;
  tags: EvalRouteTag[];
  /** Present when the trial made more calls than `MAX_ROUTE_TOOL_CALLS`. */
  truncated?: true;
};

/**
 * Derive the route of one trial from its ordered actual tool calls.
 *
 * Immediate repeats collapse into the same `pathKey` (`search,search,get`
 * → `search→get`) so a retry is not a different route, while a genuine
 * revisit (`search→get→search`) still is. Tags emit in vocabulary order.
 */
export function deriveTrialRoute(
  actualToolCalls: readonly unknown[]
): DerivedTrialRoute {
  const toolCallSequence: string[] = [];
  let truncated = false;
  for (const call of actualToolCalls) {
    const name = readToolName(call);
    if (!name) continue;
    if (toolCallSequence.length >= MAX_ROUTE_TOOL_CALLS) {
      truncated = true;
      break;
    }
    toolCallSequence.push(name);
  }

  let retryCount = 0;
  for (let index = 1; index < toolCallSequence.length; index += 1) {
    if (toolCallSequence[index] === toolCallSequence[index - 1]) {
      retryCount += 1;
    }
  }

  const nameCounts = new Map<string, number>();
  for (const name of toolCallSequence) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const tags: EvalRouteTag[] = [];
  if (toolCallSequence.length === 0) tags.push("noToolCalled");
  if (retryCount > 0) tags.push("retried");
  for (const count of nameCounts.values()) {
    if (count >= ROUTE_LOOPING_THRESHOLD) {
      tags.push("looping");
      break;
    }
  }

  return {
    pathKey: buildPathKey(toolCallSequence),
    toolCallSequence,
    retryCount,
    distinctToolCount: nameCounts.size,
    tags,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * Build a trial-population rate, or `notMeasured` when there is nothing
 * to divide. Mirrors {@link stageRate} over the verdict-policy envelope.
 */
export function evalTrialRate(
  numerator: number,
  denominator: number,
  exclusions: EvalTrialExclusions = {}
): EvalRateMeasurement {
  if (
    !Number.isInteger(numerator) ||
    !Number.isInteger(denominator) ||
    denominator <= 0 ||
    numerator < 0 ||
    numerator > denominator
  ) {
    return {
      state: "notMeasured",
      value: null,
      numerator: 0,
      denominator: 0,
      exclusions,
    };
  }
  return {
    state: "measured",
    value: numerator / denominator,
    numerator,
    denominator,
    exclusions,
  };
}

/**
 * Decide whether one trial contributes route observations, and if not, why.
 *
 * Status map from `stage-analytics-aggregate.ts` plus `failed →
 * executionFailed`. Evaluator error wins: a broken grader is not a
 * route observation.
 *
 * Absent return means the trial is INCLUDED.
 */
export function classifyRouteTrial(
  trial: Pick<RouteFactsTrialInput, "status" | "evaluatorErrored">
): EvalTrialExclusionReason | undefined {
  if (trial.evaluatorErrored === true) return "evaluatorError";
  switch (trial.status) {
    case "completed":
      return undefined;
    case "pending":
    case "running":
      return "notTerminal";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    case "setup_failed":
      return "setupFailed";
    case "timed_out":
      return "timedOut";
    case "failed":
      return "executionFailed";
    default:
      // A status this contract does not know is an unfinished trial until
      // proven otherwise — the sibling experiment contract files it the same
      // way, so two documents over one run never disagree about it.
      return "notTerminal";
  }
}

function incrementExclusion(
  exclusions: EvalTrialExclusions,
  reason: EvalTrialExclusionReason
): void {
  exclusions[reason] = (exclusions[reason] ?? 0) + 1;
}

function uniqueToolNames(calls: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const call of calls) {
    const name = readToolName(call);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function catalogMembership(
  tool: string,
  catalog: RouteFactsCatalog
): EvalToolCatalogMembership {
  if (catalog.state === "notLoaded") return "catalogNotLoaded";
  return catalog.toolNames.includes(tool) ? "inCatalog" : "outsideCatalog";
}

function compareCountThenName(
  aCount: number,
  aName: string,
  bCount: number,
  bName: string
): number {
  if (aCount !== bCount) return bCount - aCount;
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}

// ── output schemas ───────────────────────────────────────────────────────────

const routeRowSchema = z
  .object({
    pathKey: z.string().min(1),
    trials: countSchema,
    passed: countSchema,
    failed: countSchema,
  })
  .strict();
export type EvalRouteRow = z.infer<typeof routeRowSchema>;

const otherRoutesSchema = z
  .object({
    /**
     * How many distinct routes were folded, so a reader can say "N other
     * routes". Optional on READ: the builder always writes it, but a row
     * persisted by a producer that predates the field carries only the
     * trial counts, and a reader must not refuse the whole document over a
     * number it can say "and more" without.
     */
    distinctPaths: z.number().int().min(1).optional(),
    trials: countSchema,
    passed: countSchema,
    failed: countSchema,
  })
  .strict();
export type EvalOtherRoutes = z.infer<typeof otherRoutesSchema>;

const loopedOnRowSchema = z
  .object({
    tool: z.string().min(1),
    trials: countSchema,
  })
  .strict();
export type EvalRouteLoopedOn = z.infer<typeof loopedOnRowSchema>;

const routeTagsSchema = z
  .object({
    noToolCalled: evalRateMeasurementStructuralSchema,
    retried: evalRateMeasurementStructuralSchema,
    looping: evalRateMeasurementStructuralSchema,
  })
  .strict();

const caseRoutesSchema = z
  .object({
    population: z.literal(EVAL_RUN_MEASUREMENT_UNITS[1]),
    totalTrials: countSchema,
    includedTrials: countSchema,
    exclusions: evalTrialExclusionsSchema,
    routes: z.array(routeRowSchema).max(MAX_ROUTES_PER_CASE),
    otherRoutes: otherRoutesSchema.optional(),
    tags: routeTagsSchema,
    loopedOn: z.array(loopedOnRowSchema),
    endedWithQuestion: evalRateMeasurementStructuralSchema,
    /**
     * Trials whose call sequence was cut at `MAX_ROUTE_TOOL_CALLS`: their
     * route, retry count and looping tag describe the prefix only. Present
     * only when non-zero, like every other ceiling this contract marks.
     */
    truncatedTrials: countSchema.optional(),
  })
  .strict();
export type EvalCaseRoutes = z.infer<typeof caseRoutesSchema>;

const expectedMismatchRowSchema = z
  .object({
    tool: z.string().min(1),
    expectedIn: countSchema,
    notCalledIn: countSchema,
    notCalledInFailed: countSchema,
  })
  .strict();
export type EvalExpectedMismatchRow = z.infer<typeof expectedMismatchRowSchema>;

const unexpectedMismatchRowSchema = z
  .object({
    tool: z.string().min(1),
    calledIn: countSchema,
    calledInFailed: countSchema,
    catalog: evalToolCatalogMembershipSchema,
  })
  .strict();
export type EvalUnexpectedMismatchRow = z.infer<
  typeof unexpectedMismatchRowSchema
>;

const substitutionRowSchema = z
  .object({
    expected: z.string().min(1),
    observed: z.string().min(1),
    trials: countSchema,
  })
  .strict();
export type EvalSubstitutionRow = z.infer<typeof substitutionRowSchema>;

export const evalRouteMismatchFactsSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("measured"),
      /**
       * The denominator every row below is counted over: included trials
       * that are not negative tests. Carried here so a reader never borrows
       * the route rollup's `includedTrials`, which still counts negative
       * trials, for a "called in n of N".
       */
      gradeableTrials: z.number().int().min(1),
      expected: z.array(expectedMismatchRowSchema).max(MAX_MISMATCH_TOOLS),
      unexpected: z.array(unexpectedMismatchRowSchema).max(MAX_MISMATCH_TOOLS),
      substitutions: z.array(substitutionRowSchema).max(MAX_MISMATCH_TOOLS),
      truncated: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal("excludedNegativeTest"),
    })
    .strict(),
  z
    .object({
      state: z.literal("notMeasured"),
    })
    .strict(),
]);
export type EvalRouteMismatchFacts = z.infer<
  typeof evalRouteMismatchFactsSchema
>;

const caseTruncationSchema = z
  .object({
    distinctCases: z.number().int().min(1),
    retained: z.number().int().min(0),
  })
  .strict();
export type EvalRouteCaseTruncation = z.infer<typeof caseTruncationSchema>;

const evalRunRouteFactsCaseSchema = z
  .object({
    caseVariantKey: z.string().min(1),
    caseKey: z.string().min(1).optional(),
    executionVariant: evalExecutionVariantSchema.optional(),
    routes: caseRoutesSchema,
    mismatch: evalRouteMismatchFactsSchema,
  })
  .strict();
export type EvalRunRouteFactsCase = z.infer<typeof evalRunRouteFactsCaseSchema>;

export const evalRunRouteFactsStructuralSchema = z
  .object({
    schemaVersion: z.literal(EVAL_RUN_ROUTE_FACTS_SCHEMA_VERSION),
    routeFactsVersion: z.literal(ROUTE_FACTS_VERSION),
    measurementUnit: z.literal(EVAL_RUN_MEASUREMENT_UNITS[1]),
    runId: z.string().min(1),
    suiteId: z.string().min(1),
    runGroupId: z.string().min(1).optional(),
    configRevision: z.string().min(1).optional(),
    runCompletedAt: z.number().int().min(0).optional(),
    catalogState: evalRouteCatalogStateSchema,
    catalogHash: z.string().min(1).optional(),
    sourceIterationCount: countSchema,
    sourceMaxUpdatedAt: z.number().int().min(0).optional(),
    materializationState: evalStageAnalyticsMaterializationStateSchema,
    createdAt: z.number().int().min(0),
    updatedAt: z.number().int().min(0),
    totalTrials: countSchema,
    includedTrials: countSchema,
    exclusions: evalTrialExclusionsSchema,
    cases: z.array(evalRunRouteFactsCaseSchema).max(MAX_EVAL_CASE_AGGREGATIONS),
    caseTruncation: caseTruncationSchema.optional(),
  })
  .strict();

function addNestedRateIssues(
  ctx: z.RefinementCtx,
  path: PropertyKey[],
  rate: unknown
): void {
  const parsed = evalRateMeasurementSchema.safeParse(rate);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: "custom",
      path: [...path, ...issue.path],
      message: issue.message,
    });
  }
}

export const evalRunRouteFactsSchema =
  evalRunRouteFactsStructuralSchema.superRefine((row, ctx) => {
    if (
      row.includedTrials + sumExclusions(row.exclusions) !==
      row.totalTrials
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["includedTrials"],
        message:
          `includedTrials ${row.includedTrials} plus exclusions ` +
          `${sumExclusions(row.exclusions)} must equal totalTrials ` +
          `${row.totalTrials}`,
      });
    }
    if (row.sourceIterationCount !== row.totalTrials) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceIterationCount"],
        message:
          `sourceIterationCount ${row.sourceIterationCount} must equal ` +
          `totalTrials ${row.totalTrials}`,
      });
    }
    for (const [index, caseRow] of row.cases.entries()) {
      const caseExclusions = sumExclusions(caseRow.routes.exclusions);
      if (
        caseRow.routes.includedTrials + caseExclusions !==
        caseRow.routes.totalTrials
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "routes", "includedTrials"],
          message:
            `includedTrials ${caseRow.routes.includedTrials} plus exclusions ` +
            `${caseExclusions} must equal totalTrials ${caseRow.routes.totalTrials}`,
        });
      }
      if (
        caseRow.mismatch.state === "measured" &&
        caseRow.mismatch.gradeableTrials > caseRow.routes.includedTrials
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "mismatch", "gradeableTrials"],
          message: "gradeableTrials cannot exceed the case's includedTrials",
        });
      }
      addNestedRateIssues(
        ctx,
        ["cases", index, "routes", "tags", "noToolCalled"],
        caseRow.routes.tags.noToolCalled
      );
      addNestedRateIssues(
        ctx,
        ["cases", index, "routes", "tags", "retried"],
        caseRow.routes.tags.retried
      );
      addNestedRateIssues(
        ctx,
        ["cases", index, "routes", "tags", "looping"],
        caseRow.routes.tags.looping
      );
      addNestedRateIssues(
        ctx,
        ["cases", index, "routes", "endedWithQuestion"],
        caseRow.routes.endedWithQuestion
      );
    }
  });
export type EvalRunRouteFacts = z.infer<typeof evalRunRouteFactsSchema>;

function sumExclusions(exclusions: EvalTrialExclusions): number {
  let total = 0;
  for (const reason of EVAL_TRIAL_EXCLUSION_REASONS) {
    total += exclusions[reason] ?? 0;
  }
  return total;
}

// ── assemblers ───────────────────────────────────────────────────────────────

type ClassifiedTrial = {
  trial: RouteFactsTrialInput;
  exclusion?: EvalTrialExclusionReason;
  route: DerivedTrialRoute;
  expectedNames: string[];
  actualNames: string[];
  passed: boolean;
};

function classifyAll(
  trials: readonly RouteFactsTrialInput[]
): ClassifiedTrial[] {
  return trials.map((trial) => {
    const exclusion = classifyRouteTrial(trial);
    const route = deriveTrialRoute(trial.actualToolCalls);
    return {
      trial,
      exclusion,
      route,
      expectedNames: uniqueToolNames(trial.expectedToolCalls),
      actualNames: uniqueToolNames(trial.actualToolCalls),
      passed: trial.result === "passed",
    };
  });
}

export type CaseRouteRollup = EvalCaseRoutes;

/**
 * Roll one case-variant's trials into route counts, tag rates, and
 * `endedWithQuestion`. Negative tests stay in the routes.
 */
export function rollupCaseRoutes(
  trials: readonly RouteFactsTrialInput[]
): CaseRouteRollup {
  const classified = classifyAll(trials);
  return rollupClassifiedRoutes(classified);
}

function rollupClassifiedRoutes(
  classified: readonly ClassifiedTrial[]
): CaseRouteRollup {
  const exclusions: EvalTrialExclusions = {};
  const included: ClassifiedTrial[] = [];
  for (const row of classified) {
    if (row.exclusion) {
      incrementExclusion(exclusions, row.exclusion);
      continue;
    }
    included.push(row);
  }

  const routeCounts = new Map<
    string,
    { trials: number; passed: number; failed: number }
  >();
  const loopedOn = new Map<string, number>();
  let noToolCalled = 0;
  let retried = 0;
  let looping = 0;
  let endedWithQuestionTrue = 0;
  let endedWithQuestionKnown = 0;
  let truncatedTrials = 0;

  for (const row of included) {
    const existing = routeCounts.get(row.route.pathKey) ?? {
      trials: 0,
      passed: 0,
      failed: 0,
    };
    existing.trials += 1;
    if (row.passed) existing.passed += 1;
    else existing.failed += 1;
    routeCounts.set(row.route.pathKey, existing);

    if (row.route.truncated) truncatedTrials += 1;
    if (row.route.tags.includes("noToolCalled")) noToolCalled += 1;
    if (row.route.tags.includes("retried")) retried += 1;
    if (row.route.tags.includes("looping")) looping += 1;

    const nameCounts = new Map<string, number>();
    for (const name of row.route.toolCallSequence) {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    for (const [tool, count] of nameCounts) {
      if (count >= ROUTE_LOOPING_THRESHOLD) {
        loopedOn.set(tool, (loopedOn.get(tool) ?? 0) + 1);
      }
    }

    if (typeof row.trial.endedWithQuestion === "boolean") {
      endedWithQuestionKnown += 1;
      if (row.trial.endedWithQuestion) endedWithQuestionTrue += 1;
    }
  }

  const sortedRoutes = [...routeCounts.entries()]
    .map(([pathKey, counts]) => ({ pathKey, ...counts }))
    .sort((a, b) =>
      compareCountThenName(a.trials, a.pathKey, b.trials, b.pathKey)
    );

  let otherRoutes: EvalOtherRoutes | undefined;
  let routes = sortedRoutes;
  if (sortedRoutes.length > MAX_ROUTES_PER_CASE) {
    routes = sortedRoutes.slice(0, MAX_ROUTES_PER_CASE);
    const tail = sortedRoutes.slice(MAX_ROUTES_PER_CASE);
    otherRoutes = tail.reduce(
      (acc, row) => ({
        distinctPaths: acc.distinctPaths + 1,
        trials: acc.trials + row.trials,
        passed: acc.passed + row.passed,
        failed: acc.failed + row.failed,
      }),
      { distinctPaths: 0, trials: 0, passed: 0, failed: 0 }
    );
  }

  return {
    population: "trial",
    totalTrials: classified.length,
    includedTrials: included.length,
    exclusions,
    routes,
    ...(otherRoutes ? { otherRoutes } : {}),
    tags: {
      noToolCalled: evalTrialRate(noToolCalled, included.length, exclusions),
      retried: evalTrialRate(retried, included.length, exclusions),
      looping: evalTrialRate(looping, included.length, exclusions),
    },
    loopedOn: [...loopedOn.entries()]
      .map(([tool, trials]) => ({ tool, trials }))
      .sort((a, b) => compareCountThenName(a.trials, a.tool, b.trials, b.tool)),
    endedWithQuestion: evalTrialRate(
      endedWithQuestionTrue,
      endedWithQuestionKnown,
      exclusions
    ),
    ...(truncatedTrials > 0 ? { truncatedTrials } : {}),
  };
}

/**
 * Name-level mismatch facts for one case-variant.
 *
 * Negative tests never enter. Catalog-not-loaded forbids substitution.
 */
export function mismatchFacts(
  trials: readonly RouteFactsTrialInput[],
  catalog: RouteFactsCatalog
): EvalRouteMismatchFacts {
  return mismatchClassified(classifyAll(trials), catalog);
}

function mismatchClassified(
  classified: readonly ClassifiedTrial[],
  catalog: RouteFactsCatalog
): EvalRouteMismatchFacts {
  const included = classified.filter((row) => !row.exclusion);
  const gradeable = included.filter((row) => row.trial.isNegativeTest !== true);
  if (gradeable.length === 0) {
    return included.length > 0 &&
      included.every((row) => row.trial.isNegativeTest === true)
      ? { state: "excludedNegativeTest" }
      : { state: "notMeasured" };
  }

  const expected = new Map<
    string,
    { expectedIn: number; notCalledIn: number; notCalledInFailed: number }
  >();
  const unexpected = new Map<
    string,
    { calledIn: number; calledInFailed: number }
  >();
  const substitutions = new Map<
    string,
    { expected: string; observed: string; trials: number }
  >();

  for (const row of gradeable) {
    const expectedSet = new Set(row.expectedNames);
    const actualSet = new Set(row.actualNames);
    const missing = row.expectedNames.filter((name) => !actualSet.has(name));
    const extra = row.actualNames.filter((name) => !expectedSet.has(name));

    for (const tool of row.expectedNames) {
      const current = expected.get(tool) ?? {
        expectedIn: 0,
        notCalledIn: 0,
        notCalledInFailed: 0,
      };
      current.expectedIn += 1;
      if (!actualSet.has(tool)) {
        current.notCalledIn += 1;
        if (!row.passed) current.notCalledInFailed += 1;
      }
      expected.set(tool, current);
    }

    for (const tool of extra) {
      const current = unexpected.get(tool) ?? {
        calledIn: 0,
        calledInFailed: 0,
      };
      current.calledIn += 1;
      if (!row.passed) current.calledInFailed += 1;
      unexpected.set(tool, current);
    }

    if (
      missing.length === 1 &&
      extra.length === 1 &&
      catalogMembership(extra[0]!, catalog) === "inCatalog"
    ) {
      const key = `${missing[0]!}\u0000${extra[0]!}`;
      const current = substitutions.get(key) ?? {
        expected: missing[0]!,
        observed: extra[0]!,
        trials: 0,
      };
      current.trials += 1;
      substitutions.set(key, current);
    }
  }

  // Count-desc then name, like routes and `loopedOn`: when the cap drops
  // rows, the ones that survive are the ones most trials touched, not the
  // ones whose names sort first.
  const expectedRows = [...expected.entries()]
    .map(([tool, counts]) => ({ tool, ...counts }))
    .sort((a, b) =>
      a.notCalledIn !== b.notCalledIn
        ? b.notCalledIn - a.notCalledIn
        : a.expectedIn !== b.expectedIn
          ? b.expectedIn - a.expectedIn
          : a.tool < b.tool
            ? -1
            : a.tool > b.tool
              ? 1
              : 0
    );
  const unexpectedRows = [...unexpected.entries()]
    .map(([tool, counts]) => ({
      tool,
      ...counts,
      catalog: catalogMembership(tool, catalog),
    }))
    .sort((a, b) =>
      a.calledIn !== b.calledIn
        ? b.calledIn - a.calledIn
        : a.tool < b.tool
          ? -1
          : a.tool > b.tool
            ? 1
            : 0
    );
  const substitutionRows = [...substitutions.values()].sort((a, b) => {
    if (a.expected !== b.expected) {
      return a.expected < b.expected ? -1 : 1;
    }
    return a.observed < b.observed ? -1 : a.observed > b.observed ? 1 : 0;
  });

  const truncated =
    expectedRows.length > MAX_MISMATCH_TOOLS ||
    unexpectedRows.length > MAX_MISMATCH_TOOLS ||
    substitutionRows.length > MAX_MISMATCH_TOOLS;

  return {
    state: "measured",
    gradeableTrials: gradeable.length,
    expected: expectedRows.slice(0, MAX_MISMATCH_TOOLS),
    unexpected: unexpectedRows.slice(0, MAX_MISMATCH_TOOLS),
    substitutions: substitutionRows.slice(0, MAX_MISMATCH_TOOLS),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * Assemble one run's route facts. Pure: `now` is the only clock.
 *
 * Re-exported as the single producer the client and the backend golden
 * both call. A hand-written Convex mirror must match this output
 * byte-for-byte on the golden fixture.
 */
export function buildEvalRunRouteFacts(
  input: RouteFactsInput
): EvalRunRouteFacts {
  const classified = classifyAll(input.trials);
  const runExclusions: EvalTrialExclusions = {};
  let includedTrials = 0;
  for (const row of classified) {
    if (row.exclusion) incrementExclusion(runExclusions, row.exclusion);
    else includedTrials += 1;
  }

  const byCase = new Map<string, ClassifiedTrial[]>();
  for (const row of classified) {
    const key = row.trial.caseVariantKey;
    const list = byCase.get(key);
    if (list) list.push(row);
    else byCase.set(key, [row]);
  }

  const sortedKeys = [...byCase.keys()].sort();
  const retainedKeys = sortedKeys.slice(0, MAX_EVAL_CASE_AGGREGATIONS);
  const caseTruncation =
    sortedKeys.length > MAX_EVAL_CASE_AGGREGATIONS
      ? {
          distinctCases: sortedKeys.length,
          retained: retainedKeys.length,
        }
      : undefined;

  const cases: EvalRunRouteFactsCase[] = retainedKeys.map((caseVariantKey) => {
    const rows = byCase.get(caseVariantKey)!;
    // Every other field is sorted before it is read; the case's own labels
    // must be too, or a shuffled input could pick a different trial's
    // `caseKey` and break the byte-stable output.
    const first = [...rows].sort((a, b) =>
      a.trial.trialKey < b.trial.trialKey
        ? -1
        : a.trial.trialKey > b.trial.trialKey
          ? 1
          : 0
    )[0]!.trial;
    return {
      caseVariantKey,
      ...(first.caseKey ? { caseKey: first.caseKey } : {}),
      ...(first.executionVariant
        ? { executionVariant: first.executionVariant }
        : {}),
      routes: rollupClassifiedRoutes(rows),
      mismatch: mismatchClassified(rows, input.catalog),
    };
  });

  const catalogHash =
    input.catalog.state === "loaded" && input.catalog.hash
      ? input.catalog.hash
      : undefined;

  const document: EvalRunRouteFacts = {
    schemaVersion: EVAL_RUN_ROUTE_FACTS_SCHEMA_VERSION,
    routeFactsVersion: ROUTE_FACTS_VERSION,
    measurementUnit: "trial",
    runId: input.run.runId,
    suiteId: input.run.suiteId,
    ...(input.run.runGroupId ? { runGroupId: input.run.runGroupId } : {}),
    ...(input.run.configRevision
      ? { configRevision: input.run.configRevision }
      : {}),
    ...(input.run.runCompletedAt !== undefined
      ? { runCompletedAt: input.run.runCompletedAt }
      : {}),
    catalogState: input.catalog.state,
    ...(catalogHash ? { catalogHash } : {}),
    sourceIterationCount: input.trials.length,
    ...(input.run.sourceMaxUpdatedAt !== undefined
      ? { sourceMaxUpdatedAt: input.run.sourceMaxUpdatedAt }
      : {}),
    materializationState: input.run.materializationState,
    createdAt: input.run.createdAt ?? input.run.now,
    updatedAt: input.run.now,
    totalTrials: input.trials.length,
    includedTrials,
    exclusions: runExclusions,
    cases,
    ...(caseTruncation ? { caseTruncation } : {}),
  };

  const parsed = evalRunRouteFactsSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(
      `buildEvalRunRouteFacts produced an invalid document: ${parsed.error.message}`
    );
  }
  return parsed.data;
}
