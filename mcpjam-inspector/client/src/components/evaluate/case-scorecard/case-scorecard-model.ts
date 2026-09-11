/**
 * One case's scorers, in the order the chain grades them.
 *
 * THE PROBLEM THIS SOLVES. A suite's Grading tab says Scorers, Judge, and
 * Gate / Warn / Report, and groups them by the link of the user-value chain
 * each one measures. The case page said "Check the result", "Which tool should
 * handle it?", "Model grader · advisory", and "More checks" — grouped by a
 * private three-way partition that deliberately disagreed with
 * `PREDICATE_STAGE`. Same objects, two vocabularies, one click apart.
 *
 * So this module answers, for ONE case, the question the suite table answers
 * for a suite: what will grade this, in what order, under which role, and who
 * wrote it. The last part is new — a case has FOUR authors (the route
 * question, its own steps, its own predicate list, and the suite's defaults)
 * where a suite has one, so every row carries its provenance.
 *
 * THREE RULES KEEP IT HONEST.
 *
 *   1. Stage routing is `PREDICATE_STAGE`, the same table the analyzer's own
 *      selection routing derives from. A second opinion in the client is a
 *      second opinion, and the one that disagrees with the analyzer is the one
 *      on the page.
 *   2. Nothing here reads a run. It is configuration — "what will grade this"
 *      — and `result` is filled afterwards by `joinTrialResults`, from server
 *      facts only. A row that joined nothing says "not measured"; it never
 *      says "passed".
 *   3. `key` is UI identity, `join` is result identity, and they are
 *      deliberately different. Two identical predicates are two rows the
 *      author can edit separately, but ONE hosted criterion — the server
 *      de-dupes definitions by id — so both rows receive the same result.
 *
 * TOTAL AND NON-THROWING, like the suite model: a predicate kind this build
 * does not know files at `userValue` with its raw type as the label rather
 * than blanking the page.
 */

import {
  PREDICATE_STAGE,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_QUESTIONS,
  USER_VALUE_STAGES,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import type { PredicateScope } from "@mcpjam/sdk/predicates";
import {
  hostedCriterionId,
  HOSTED_JUDGE_SCORER_ID,
  HOSTED_TOOL_MATCH_SCORER_ID,
} from "@/shared/hosted-criterion-id";
import {
  MATCH_OPTIONS_DEFAULTS,
  resolveCasePredicates,
  resolveMatchOptions,
  type CasePredicates,
  type EvalMatchOptions,
  type Predicate,
} from "@/shared/eval-matching";
import {
  actionRows,
  isAssertStep,
  isWidgetAssertion,
  isModelFree,
  stepTurnIndices,
  WIDGET_ASSERTION_LABELS,
  type TestStep,
  type WidgetAssertion,
} from "@/shared/steps";
import {
  formatCriterion,
  INLINE_ASSERT_LABELS,
  PREDICATE_KIND_LABELS,
  type PredicateKind,
} from "@/shared/predicate-kinds";
import { GOAL_COMPLETION_DEFAULTS } from "@/shared/judge-defaults";
import {
  LIBRARY_OPT_IN_KINDS,
  ROLE_LEGEND,
  roleOfJudgeSlot,
  roleOfPredicate,
  type ScorerUiRole,
} from "@/components/evals/suite-scorer-table-model";
import { judgeMode, type JudgeMode } from "@/components/evals/suite-grading-model";
import type {
  EvalJudgeConfig,
  EvalJudgeConfigOverride,
  EvalJudgeRubric,
} from "@/components/evals/types";
import {
  caseHasOwnAssertion,
  displayCaseKind,
  isPromptFirst,
  isStepCheckAssert,
  isToolCalledWithAssert,
  isWidgetAssertStep,
  readSimpleCase,
  resolveToolsQuestion,
  UNSET_TOOLS_BLOCK_REASON,
  type CaseKind,
  type SimpleCaseTool,
  type ToolsChoice,
} from "../simple-case/simple-case-model";

/**
 * Where a widget assertion files.
 *
 * `PREDICATE_STAGE` has no entry for widget kinds — they are not predicates,
 * they are DOM assertions with their own union — so this is the page's own
 * decision rather than the contract's. `userValue` is where the contract
 * already routes evidence it cannot split more finely, and a rendered view is
 * about whether the user got what they asked for. Marked as a constant, and
 * named in the plan as a follow-up for the contract to own.
 */
export const WIDGET_ASSERT_STAGE: UserValueStage = "userValue";

/**
 * Kinds the route question owns, so the scorer library must not offer them.
 *
 * Offering `toolCalledWith` twice would let a reader author a route that the
 * route row then contradicts. (Formerly `EXCLUDED_FROM_MORE_CHECKS`.)
 */
export const ROUTE_OWNED_KINDS: ReadonlySet<PredicateKind> =
  new Set<PredicateKind>(["toolCalledWith"]);

/**
 * What the case page's "+ Add scorer" library may offer.
 *
 * Excludes the route's own kind (offering it twice would let a reader author a
 * route the route row then contradicts) and the opt-in kinds, which are
 * offered only where they replace an existing control rather than sit beside
 * it — see {@link spineLibraryKinds}.
 */
export function caseLibraryKinds(
  kinds: readonly PredicateKind[] = Object.keys(
    PREDICATE_KIND_LABELS,
  ) as PredicateKind[],
): PredicateKind[] {
  return kinds.filter(
    (kind) => !ROUTE_OWNED_KINDS.has(kind) && !LIBRARY_OPT_IN_KINDS.has(kind),
  );
}

/**
 * What the SPINE may offer: the case library plus the opt-in kinds.
 *
 * `onlyToolsCalled` belongs here and nowhere else. On the spine it is the
 * honest way to say "and nothing else was called", a claim that otherwise
 * lives only in the matcher's options and the case-level negative flag —
 * neither of which an author can scope to a turn or demote to a warning.
 */
export function spineLibraryKinds(): PredicateKind[] {
  return [
    ...caseLibraryKinds(),
    ...([...LIBRARY_OPT_IN_KINDS] as PredicateKind[]),
  ];
}

export type ScorecardProvenance =
  | "route"
  | "step"
  | "case"
  | "suite"
  | "snapshot"
  | "judge";

/** How a row finds its result on a trial. See `joinTrialResults`. */
export type ScorecardJoin =
  | { kind: "toolMatch"; scorerId: string }
  | {
      kind: "step";
      stepId: string;
      criterionId?: string;
      scope?: PredicateScope;
    }
  | { kind: "predicate"; criterionId: string }
  | { kind: "judge"; slot: "goalCompletion"; scorerId: string };

/** What the route question currently answers. */
export type RouteState =
  | {
      kind: "tools";
      tools: SimpleCaseTool[];
      matchMode: CaseKind;
      resolvedMatch: EvalMatchOptions;
    }
  | { kind: "noTool" }
  | { kind: "checks" }
  | { kind: "unset" }
  /**
   * No model turn for a route claim to be about. Existing tool asserts are
   * still carried and still shown, read-only: they are steps in this case, and
   * a locked question that HID them would drop them from every editor on the
   * surface — `leftoverSteps` does not list them either, by construction.
   */
  | {
      kind: "locked";
      reason: "pinnedFirst" | "modelFree";
      tools: SimpleCaseTool[];
    };

/**
 * What the judge will actually do to this case, read off the suite plus the
 * one per-case override the backend admits.
 */
export type JudgeFacts = {
  suiteMode: JudgeMode;
  model: string;
  threshold: number;
  suiteCriteriaCount: number;
  /** `judgeConfigOverride.goalCompletion.enabled === false`. */
  skippedForCase: boolean;
  runsForCase: boolean;
  rubricSource: RubricSource;
  goal: string;
};

/**
 * Which rubric the backend will grade this case against.
 *
 * Mirrors the precedence in the backend's `buildGoalCompletionIterationContexts`
 * — explicit `expectedOutput`, else a rubric derived from the case's own route
 * or negative flag, else the suite's criteria, else objective mode with its
 * score capped. Mirrored rather than guessed because the page's whole claim
 * here is "this is what the judge will read".
 */
export type RubricSource =
  | "expected_output"
  | "assertions"
  | "suite_criteria"
  | "objective";

/** The cap the backend applies when a case has no rubric at all. */
export const OBJECTIVE_MODE_SCORE_CAP = 0.85;

export const RUBRIC_SOURCE_HINT: Record<RubricSource, string> = {
  expected_output:
    "The judge grades against this sentence. Suite criteria also apply.",
  assertions:
    "No goal sentence — the judge grades against the expected route. Add a sentence to grade the answer itself.",
  suite_criteria:
    "No goal sentence or route — the judge grades against the suite's criteria.",
  objective: `No rubric — the judge grades against the request itself, with its score capped at ${OBJECTIVE_MODE_SCORE_CAP}.`,
};

export const JUDGE_MODE_WORD: Record<JudgeMode, string> = {
  off: "off",
  manual: "on request",
  automatic: "automatic",
  gating: "gating",
};

export type ScorecardRow = {
  /** Unique within one scorecard. Not persisted; not the join key. */
  key: string;
  stage: UserValueStage;
  provenance: ScorecardProvenance;
  /** Human, always. A wire enum here for a known kind is a bug. */
  label: string;
  kindLabel: string;
  role: ScorerUiRole;
  /** Why this surface cannot author the role. `"none"` means it can. */
  roleLock: "none" | "route" | "inherited" | "widget" | "judge";
  /** Whether the case page may edit or delete this row's own fields. */
  editable: boolean;
  /**
   * The step's own 1-based position in the flat step list — the SAME number
   * the Steps pane prints for it.
   *
   * It used to be the turn ordinal, labelled "Step N", so three checks
   * authored inside turn 1 all read "Step 1" while the Steps pane called them
   * 2, 3 and 4. Two panes numbering one step differently is worse than either
   * numbering alone.
   *
   * Present only on rows that HAVE a position. A case- or suite-level check
   * is graded once over the finished transcript, at the same moment as every
   * other one, so numbering it would assert a sequence that does not exist.
   */
  stepNumber?: number;
  stepId?: string;
  predicateIndex?: number;
  predicate?: Predicate;
  widgetAssertion?: WidgetAssertion;
  route?: RouteState;
  judge?: JudgeFacts;
  tooltip: string;
  join?: ScorecardJoin;
};

export type ScorecardGroup = {
  stage: UserValueStage;
  label: string;
  question: string;
  rows: ScorecardRow[];
};

export type CaseScorecard = {
  /** Chain order, and only stages that have a row. */
  groups: ScorecardGroup[];
  route: ScorecardRow;
  judge: ScorecardRow;
  envelopeMode: "inherit" | "extend" | "replace";
  /** Suite defaults this case replaced, and therefore does not run. */
  hiddenSuiteCount: number;
  negativeContradiction: boolean;
  unsetBlockReason: string | null;
};

export type CaseScorecardInput = {
  steps: TestStep[];
  toolsChoice: ToolsChoice;
  kind?: CaseKind | null;
  matchOptions?: EvalMatchOptions;
  suiteDefaultMatchOptions?: EvalMatchOptions;
  predicates?: CasePredicates;
  suiteDefaultPredicates?: Predicate[];
  /**
   * Inspect mode. A frozen trial carries the RESOLVED predicate list only, so
   * suite-vs-case provenance is unknowable there; supplying this replaces both
   * with one "Run snapshot" group rather than guessing.
   */
  snapshotPredicates?: Predicate[];
  expectedOutput?: string;
  judgeConfigOverride?: EvalJudgeConfigOverride;
  suiteJudgeConfig?: EvalJudgeConfig;
  suiteJudgeRubric?: EvalJudgeRubric;
  /**
   * How a step row is numbered.
   *
   * `"flat"` (default) numbers by position in `steps`, which is what the Steps
   * pane shows — keep it for every surface that still renders beside that pane.
   *
   * `"action"` numbers by the ACTION the check sits under: the spine numbers
   * prompts, pinned calls and clicks 1..N and nests each check beneath one of
   * them, so a check's badge has to name its action, not its own offset. Both
   * `buildCaseScorecard` call sites on a spine surface must pass the same
   * value — the left pane and the trial scorecard disagreeing about which
   * number a check wears is worse than either numbering alone.
   */
  numbering?: "flat" | "action";
};

/** Contradicts a "no tool should be called" answer. */
const NEGATIVE_CONTRADICTING_KINDS: ReadonlySet<PredicateKind> =
  new Set<PredicateKind>([
    "toolCalledWith",
    "toolCalledAtLeastOnce",
    "firstToolWas",
  ]);

/**
 * What a check PROTECTS, in words a reader who has never authored an eval can
 * repeat.
 *
 * `PREDICATE_KIND_LABELS` names the mechanism ("Response contains…"); this
 * names the reason to have it ("Check the answer mentions …"). A suggestion
 * leads with the purpose and shows the mechanism underneath, because a row that
 * opens with "Response contains ORD-48213" tells the reader WHAT it does and
 * nothing about whether they want it.
 *
 * Exhaustive over `PredicateKind` by construction: the `Record` type makes a
 * new kind a compile error here, the same forcing point `PREDICATE_KIND_LABELS`
 * and `blankPredicate` already use. The fallback below is for a kind that
 * arrived from the wire on an older/newer build, never for a known one.
 */
const PREDICATE_PURPOSE: Record<PredicateKind, string> = {
  toolCalledWith: "Require this tool, with these arguments",
  toolCalledAtLeastOnce: "Require this tool on future runs",
  toolNeverCalled: "Catch this tool being called",
  onlyToolsCalled: "Require that nothing else is called",
  firstToolWas: "Require this tool to be reached first",
  responseContains: "Check what the answer says",
  responseMatches: "Check the answer's shape",
  noToolErrors: "Catch tool failures",
  finalAssistantMessageNonEmpty: "Catch an empty answer",
  tokenBudgetUnder: "Track increases in token usage",
  widgetRendered: "Verify the view renders",
  widgetRenderLatencyUnder: "Track the view getting slower",
  widgetNoConsoleErrors: "Catch view console errors",
  turnCountUnder: "Track longer conversations",
  noEndingQuestion: "Catch an answer that ends by asking",
  // What the server sent back, and what it cost to read.
  toolResultContains: "Check what a tool returned",
  toolResultMatchesSchema: "Check the shape of what a tool returned",
  toolResultSizeUnder: "Track a tool's payload growing",
  toolLatencyUnder: "Track a tool getting slower",
  fullPageHasContinuation: "Catch a full page with no way to ask for more",
  toolErrorNamesInput: "Catch an error that names none of its inputs",
  // Which tools were reached, in what order, and how many times.
  toolCallCountUnder: "Track the number of tool calls",
  toolCalledBefore: "Require this tool before that one",
  noRepeatedIdenticalCall: "Catch the same call being made twice over",
  argumentsMatchToolSchema: "Catch arguments the tool's own schema rejects",
  noDeprecatedToolCalled: "Catch a tool the server calls deprecated",
  noDestructiveToolCalled: "Catch a tool the server marks destructive",
};

const WIDGET_PURPOSE: Record<WidgetAssertion["kind"], string> = {
  textVisible: "Verify the view shows this text",
  elementVisible: "Verify the view shows this element",
  elementHidden: "Verify the view hides this element",
  inputValue: "Verify this field's value",
  widgetToolCalled: "Verify the click calls the right tool",
};

/**
 * The purpose line for either kind of authored check.
 *
 * Falls back to the mechanism label for an unknown kind — the same degradation
 * `scorerRowLabel` uses — so an unrecognised predicate reads as its type rather
 * than as an empty row.
 */
export function purposeOf(assertion: Predicate | WidgetAssertion): string {
  if (isWidgetAssertion(assertion)) {
    return (
      WIDGET_PURPOSE[assertion.kind] ??
      WIDGET_ASSERTION_LABELS[assertion.kind] ??
      String(assertion.kind)
    );
  }
  const kind = assertion.type as PredicateKind;
  return PREDICATE_PURPOSE[kind] ?? PREDICATE_KIND_LABELS[kind] ?? String(kind);
}

export function stageOfPredicate(predicate: Predicate): UserValueStage {
  return PREDICATE_STAGE[predicate.type as PredicateKind] ?? "userValue";
}

/**
 * A row's one-line name.
 *
 * A step-authored check is labelled by WHERE it runs: it sees the transcript
 * up to its own position, so `noToolErrors` as a step reads "No tool errors so
 * far" while the whole-run one reads "No tool errors". Same predicate,
 * different claim, and the label is the only place a reader learns that.
 */
export function scorerRowLabel(
  predicate: Predicate,
  provenance: ScorecardProvenance,
): string {
  const kind = predicate.type as PredicateKind;
  if (!(kind in PREDICATE_KIND_LABELS)) return String(predicate.type);
  if (provenance === "step" && INLINE_ASSERT_LABELS[kind]) {
    return INLINE_ASSERT_LABELS[kind] as string;
  }
  return formatCriterion({ predicate });
}

export function scorerKindLabel(predicate: Predicate): string {
  const kind = predicate.type as PredicateKind;
  return PREDICATE_KIND_LABELS[kind] ?? String(predicate.type);
}

/**
 * The turn a step's assert is scoped to.
 *
 * Must equal what the runner used, or the row joins nothing: the hosted
 * step-check adapter scopes each assert with `stepTurnIndices(steps)[index]`.
 */
export function stepScope(
  steps: TestStep[],
  stepId: string,
): PredicateScope | undefined {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index < 0) return undefined;
  const promptIndex = stepTurnIndices(steps)[index];
  if (typeof promptIndex !== "number") return undefined;
  return { kind: "turn", promptIndex };
}

function rowTooltip(kindLabel: string, role: ScorerUiRole, inline: boolean) {
  const parts = [kindLabel, ROLE_LEGEND[role].meaning];
  if (inline) {
    parts.push("Graded where it sits in the run, not over the whole trial.");
  }
  return parts.join(" ");
}

export function routeLabel(state: RouteState): string {
  switch (state.kind) {
    case "tools": {
      const names = state.tools.map((tool) => tool.toolName).filter(Boolean);
      if (names.length === 0) return "Which tool should handle it?";
      return state.matchMode === "regression"
        ? `Exact route: ${names.join(" → ")}`
        : `Reach ${names.join(", ")}`;
    }
    case "noTool":
      return "No tool should be called";
    case "checks":
      return "Any route — graded by the scorers below";
    case "unset":
      return "Which tool should handle it?";
    case "locked":
      return state.reason === "modelFree"
        ? "Pinned tool call — no model route"
        : "This case does not start with a prompt";
  }
}

/**
 * Which rubric the judge will read, by the backend's own precedence.
 *
 * `assertions` covers both halves of the backend's derived rubric: a negative
 * case ("without calling any tools") and a routed one ("expected to make these
 * tool calls"). A case with neither a sentence nor a route falls to the suite's
 * criteria, and with neither of those to objective mode.
 */
export function deriveRubricSource(input: {
  expectedOutput?: string;
  route: RouteState;
  suiteCriteriaCount: number;
}): RubricSource {
  if (input.expectedOutput && input.expectedOutput.trim().length > 0) {
    return "expected_output";
  }
  if (
    input.route.kind === "noTool" ||
    (input.route.kind === "tools" && input.route.tools.length > 0)
  ) {
    return "assertions";
  }
  if (input.suiteCriteriaCount > 0) return "suite_criteria";
  return "objective";
}

export function judgeFacts(input: {
  expectedOutput?: string;
  judgeConfigOverride?: EvalJudgeConfigOverride;
  suiteJudgeConfig?: EvalJudgeConfig;
  suiteJudgeRubric?: EvalJudgeRubric;
  route: RouteState;
}): JudgeFacts {
  const slot = input.suiteJudgeConfig?.goalCompletion;
  const suiteMode = judgeMode(input.suiteJudgeConfig);
  const skippedForCase =
    input.judgeConfigOverride?.goalCompletion?.enabled === false;
  const suiteCriteriaCount = input.suiteJudgeRubric?.criteria.length ?? 0;
  return {
    suiteMode,
    model: slot?.judgeModel ?? GOAL_COMPLETION_DEFAULTS.judgeModel,
    threshold: slot?.threshold ?? GOAL_COMPLETION_DEFAULTS.threshold,
    suiteCriteriaCount,
    skippedForCase,
    runsForCase: suiteMode !== "off" && !skippedForCase,
    rubricSource: deriveRubricSource({
      expectedOutput: input.expectedOutput,
      route: input.route,
      suiteCriteriaCount,
    }),
    goal: input.expectedOutput ?? "",
  };
}

/** The route question's current answer, from the same inputs the form uses. */
function resolveRoute(input: CaseScorecardInput): RouteState {
  const locked = readSimpleCase(input.steps);
  if (isModelFree(input.steps)) {
    return { kind: "locked", reason: "modelFree", tools: locked.tools };
  }
  if (!isPromptFirst(input.steps)) {
    return { kind: "locked", reason: "pinnedFirst", tools: locked.tools };
  }
  const view = locked;
  const question = resolveToolsQuestion({
    choice: input.toolsChoice,
    hasToolAsserts: view.tools.length > 0,
    hasOwnAssertion: caseHasOwnAssertion({
      steps: input.steps,
      expectedOutput: input.expectedOutput,
      predicates: input.predicates,
    }),
  });
  if (question === "tools") {
    const resolvedMatch = safeResolveMatchOptions(
      input.suiteDefaultMatchOptions,
      input.matchOptions,
    );
    return {
      kind: "tools",
      tools: view.tools,
      matchMode: displayCaseKind(input.kind ?? undefined, resolvedMatch),
      resolvedMatch,
    };
  }
  if (question === "noTool") return { kind: "noTool" };
  if (question === "checks") return { kind: "checks" };
  return { kind: "unset" };
}

/**
 * The resolver ASSERTS its result and a stored value from a future build could
 * fail that assertion. Falling back keeps the page readable — one wrong field
 * beats a blank page — exactly as the suite model does.
 */
function safeResolveMatchOptions(
  suiteDefaults: EvalMatchOptions | undefined,
  caseOverride: EvalMatchOptions | undefined,
): EvalMatchOptions {
  try {
    return resolveMatchOptions(suiteDefaults, caseOverride);
  } catch {
    return { ...MATCH_OPTIONS_DEFAULTS };
  }
}

function predicateRow(args: {
  predicate: Predicate;
  provenance: Exclude<ScorecardProvenance, "route" | "judge" | "step">;
  index: number;
  editable: boolean;
  roleLock: ScorecardRow["roleLock"];
}): ScorecardRow {
  const role = roleOfPredicate(args.predicate);
  const kindLabel = scorerKindLabel(args.predicate);
  return {
    key: `${args.provenance}:${args.index}`,
    stage: stageOfPredicate(args.predicate),
    provenance: args.provenance,
    label: scorerRowLabel(args.predicate, args.provenance),
    kindLabel,
    role,
    roleLock: args.roleLock,
    editable: args.editable,
    predicateIndex: args.index,
    predicate: args.predicate,
    tooltip: rowTooltip(kindLabel, role, false),
    join: {
      kind: "predicate",
      criterionId: hostedCriterionId(args.predicate),
    },
  };
}

function stepRows(
  steps: TestStep[],
  numbering: "flat" | "action" = "flat",
): ScorecardRow[] {
  // "flat": position in the list, so this pane and the Steps pane agree.
  // "action": the ordinal of the action the check hangs under, so this pane and
  // the spine agree. `actionRows` is the one projection that decides which
  // action owns a check.
  const stepNumbers =
    numbering === "action"
      ? new Map(
          actionRows(steps).actions.flatMap((action) =>
            action.checks.map(
              (child) => [child.step.id, action.ordinal] as const,
            ),
          ),
        )
      : new Map(steps.map((step, index) => [step.id, index + 1] as const));
  const rows: ScorecardRow[] = [];
  for (const step of steps) {
    if (!isAssertStep(step)) continue;
    if (isToolCalledWithAssert(step)) continue; // the route owns these
    const stepNumber = stepNumbers.get(step.id);
    if (isWidgetAssertStep(step)) {
      const assertion = step.assertion as WidgetAssertion;
      const kindLabel =
        WIDGET_ASSERTION_LABELS[assertion.kind] ?? assertion.kind;
      rows.push({
        key: `step:${step.id}`,
        stage: WIDGET_ASSERT_STAGE,
        provenance: "step",
        label: kindLabel,
        kindLabel,
        // A DOM assertion carries no check policy — there is no field to
        // author — so it is a gate and says so rather than inventing a role.
        role: "gate",
        roleLock: "widget",
        editable: true,
        stepNumber,
        stepId: step.id,
        widgetAssertion: assertion,
        tooltip: rowTooltip(kindLabel, "gate", true),
        join: { kind: "step", stepId: step.id },
      });
      continue;
    }
    if (!isStepCheckAssert(step) || isWidgetAssertion(step.assertion)) continue;
    const predicate = step.assertion;
    const role = roleOfPredicate(predicate);
    const kindLabel = scorerKindLabel(predicate);
    const scope = stepScope(steps, step.id);
    rows.push({
      key: `step:${step.id}`,
      stage: stageOfPredicate(predicate),
      provenance: "step",
      label: scorerRowLabel(predicate, "step"),
      kindLabel,
      role,
      roleLock: "none",
      editable: true,
      stepNumber,
      stepId: step.id,
      predicate,
      tooltip: rowTooltip(kindLabel, role, true),
      join: {
        kind: "step",
        stepId: step.id,
        criterionId: hostedCriterionId(predicate, scope),
        ...(scope ? { scope } : {}),
      },
    });
  }
  return rows;
}

/**
 * Build one case's scorecard.
 *
 * Pure and cheap: it reads a draft (or a frozen snapshot) and returns a
 * rendering model. No I/O, no state, and it never looks at a run.
 */
export function buildCaseScorecard(input: CaseScorecardInput): CaseScorecard {
  const route = resolveRoute(input);
  const facts = judgeFacts({
    expectedOutput: input.expectedOutput,
    judgeConfigOverride: input.judgeConfigOverride,
    suiteJudgeConfig: input.suiteJudgeConfig,
    suiteJudgeRubric: input.suiteJudgeRubric,
    route,
  });

  const routeRow: ScorecardRow = {
    key: "route",
    stage: "selection",
    provenance: "route",
    label: routeLabel(route),
    kindLabel: "Route",
    // The matcher is always a gate: an advisory route is not a route (see
    // `isToolCalledWithAssert`), so there is nothing here to lower.
    role: "gate",
    roleLock: "route",
    editable: route.kind !== "locked",
    route,
    tooltip: rowTooltip(
      "Tool-call matching",
      "gate",
      false,
    ),
    ...(route.kind === "tools" || route.kind === "noTool"
      ? {
          join: {
            kind: "toolMatch" as const,
            scorerId: HOSTED_TOOL_MATCH_SCORER_ID,
          },
        }
      : {}),
  };

  const judgeRole = roleOfJudgeSlot("goalCompletion", input.suiteJudgeConfig);
  const judgeRow: ScorecardRow = {
    key: "judge:goalCompletion",
    stage: "userValue",
    provenance: "judge",
    label: "Judge · Goal completion",
    kindLabel: "Judge",
    role: judgeRole,
    roleLock: "judge",
    editable: true,
    judge: facts,
    tooltip: rowTooltip(
      "A judge scores trial evidence from 0 to 1.",
      judgeRole,
      false,
    ),
    join: {
      kind: "judge",
      slot: "goalCompletion",
      scorerId: HOSTED_JUDGE_SCORER_ID,
    },
  };

  const envelopeMode = input.predicates?.mode ?? "inherit";
  const suiteDefaults = input.suiteDefaultPredicates ?? [];
  const frozen = input.snapshotPredicates;

  const caseRows: ScorecardRow[] = frozen
    ? frozen.map((predicate, index) =>
        predicateRow({
          predicate,
          provenance: "snapshot",
          index,
          editable: false,
          roleLock: "inherited",
        }),
      )
    : (envelopeMode === "inherit" ? [] : (input.predicates?.list ?? [])).map(
        (predicate, index) =>
          predicateRow({
            predicate,
            provenance: "case",
            index,
            editable: true,
            roleLock: "none",
          }),
      );

  const suiteRows: ScorecardRow[] =
    frozen || envelopeMode === "replace"
      ? []
      : suiteDefaults.map((predicate, index) =>
          predicateRow({
            predicate,
            provenance: "suite",
            index,
            editable: false,
            roleLock: "inherited",
          }),
        );

  const steps = frozen ? input.steps : input.steps;
  const authoredStepRows = stepRows(steps, input.numbering ?? "flat");

  const byStage = new Map<UserValueStage, ScorecardRow[]>();
  const push = (row: ScorecardRow) => {
    const list = byStage.get(row.stage) ?? [];
    list.push(row);
    byStage.set(row.stage, list);
  };
  push(routeRow);
  authoredStepRows.forEach(push);
  caseRows.forEach(push);
  suiteRows.forEach(push);
  push(judgeRow);

  const groups: ScorecardGroup[] = USER_VALUE_STAGES.filter((stage) =>
    byStage.has(stage),
  ).map((stage) => ({
    stage,
    label: USER_VALUE_STAGE_LABELS[stage],
    question: USER_VALUE_STAGE_QUESTIONS[stage],
    rows: byStage.get(stage) ?? [],
  }));

  const contradicting = [...authoredStepRows, ...caseRows, ...suiteRows].some(
    (row) =>
      row.predicate !== undefined &&
      NEGATIVE_CONTRADICTING_KINDS.has(row.predicate.type as PredicateKind),
  );

  return {
    groups,
    route: routeRow,
    judge: judgeRow,
    envelopeMode,
    hiddenSuiteCount:
      !frozen && envelopeMode === "replace" ? suiteDefaults.length : 0,
    negativeContradiction: route.kind === "noTool" && contradicting,
    unsetBlockReason:
      route.kind === "unset" ? UNSET_TOOLS_BLOCK_REASON : null,
  };
}

/**
 * The effective predicate list, for the one assertion worth making about it:
 * the case + suite rows a scorecard renders are exactly what the runner will
 * evaluate. Re-exported so the test can compare against the real resolver
 * rather than a second copy of its rules.
 */
export function effectiveCasePredicates(
  input: Pick<CaseScorecardInput, "predicates" | "suiteDefaultPredicates">,
): Predicate[] {
  return (
    resolveCasePredicates(input.suiteDefaultPredicates, input.predicates) ?? []
  );
}

// ---------------------------------------------------------------------------
// Writers. Pure: they return the next value, the component calls the prop.
// ---------------------------------------------------------------------------

/**
 * The one per-case judge control the backend admits.
 *
 * `judgeConfigOverride` is opt-out only — no per-case model, threshold or
 * role — so this writes `enabled: false` or removes the slot entirely.
 * Returning `undefined` rather than `{}` matters: the editor sends `null` for
 * undefined, which is how a cleared override is actually cleared.
 */
export function withCaseJudgeSkipped(
  current: EvalJudgeConfigOverride | undefined,
  skipped: boolean,
): EvalJudgeConfigOverride | undefined {
  if (skipped) {
    return {
      ...current,
      goalCompletion: { ...current?.goalCompletion, enabled: false },
    };
  }
  if (!current?.goalCompletion) return current ?? undefined;
  const { enabled: _enabled, ...restSlot } = current.goalCompletion;
  const hasRest = Object.keys(restSlot).length > 0;
  const next: EvalJudgeConfigOverride = {
    ...current,
    ...(hasRest ? { goalCompletion: restSlot } : {}),
  };
  if (!hasRest) delete (next as { goalCompletion?: unknown }).goalCompletion;
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Append a case-level scorer.
 *
 * Keeps `replace` when that is what the case says: a case that deliberately
 * replaced its suite defaults must not be quietly switched back to extending
 * them by the act of adding one more check.
 */
export function appendCaseScorer(
  current: CasePredicates | undefined,
  predicate: Predicate,
): CasePredicates {
  const mode = current?.mode === "replace" ? "replace" : "extend";
  return { mode, list: [...(current?.list ?? []), predicate] };
}

export function updateCaseScorer(
  current: CasePredicates | undefined,
  index: number,
  next: Predicate,
): CasePredicates {
  const list = [...(current?.list ?? [])];
  list[index] = next;
  return { mode: current?.mode === "replace" ? "replace" : "extend", list };
}

/** An empty replace list deliberately keeps suite defaults excluded. */
export function removeCaseScorer(
  current: CasePredicates | undefined,
  index: number,
): CasePredicates | undefined {
  const list = (current?.list ?? []).filter((_, i) => i !== index);
  if (list.length === 0 && current?.mode !== "replace") return undefined;
  return { mode: current?.mode === "replace" ? "replace" : "extend", list };
}
