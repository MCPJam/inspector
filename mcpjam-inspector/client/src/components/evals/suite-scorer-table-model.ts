import type { GoalJudgePolicy } from "@/shared/judge-defaults";
/**
 * The Scorers table as configuration — what will grade each link of the chain.
 *
 * Pure. No rates, no run words, no I/O. `buildScorerTable` files every
 * authored check under the stage `PREDICATE_STAGE` already decided, and the
 * chain cards wear `stageConfigStates` rather than a verdict.
 */

import {
  STANDARD_CHECKS,
  authoredRequiredRole,
  GRADER_PRESENTATION_GROUP,
  PREDICATE_KINDS,
  PREDICATE_STAGE,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_QUESTIONS,
  USER_VALUE_STAGES,
  type PredicateKind,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import {
  checkRole,
  isRequiredRole,
  type Predicate,
} from "@mcpjam/sdk/predicates";
import {
  formatCriterion,
  PREDICATE_KIND_LABELS,
  type ScorerUiRole,
} from "@/shared/predicate-kinds";
import {
  STAGE_CHIP_TONE_CLASS,
  type StageCardView,
} from "@/components/evaluate/stage-chain-model";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type { EvalJudgeConfig } from "./types";
import {
  STANDARD_ASSERTION_CHECKS,
  standardCheckOfKind,
  type AssertionCheck,
  type EffectiveRule,
  type RuleSource,
} from "./standard-checks-model";
import {
  judgeMode,
  stageConfigStates,
  stageEmptyIsGap,
  type GraderRow,
  type JudgeMode,
  type StageConfigState,
  type SuiteGradingModel,
} from "./suite-grading-model";

/** Kinds the library may advertise as new. Empty until a later release. */
/**
 * Kinds a "New" chip marks in the scorer library.
 *
 * Not a changelog — the chip earns its place only while a kind is new enough
 * that an author who knows the library would not expect it. Prune it.
 */
export const NEW_SCORER_KINDS: readonly PredicateKind[] = ["noEndingQuestion"];

/**
 * The kinds every deployment has accepted since before `scorers.predicateKinds`
 * existed.
 *
 * The fallback when a backend does not advertise its accepted set: offering a
 * kind an older validator rejects turns "Add assertion" into a save that fails,
 * and offering one an older RUNNER cannot evaluate is worse — it fails closed
 * as "unknown predicate type" on every trial of the run.
 *
 * Frozen by definition. New kinds are advertised, never added here.
 */
export const LEGACY_PREDICATE_KINDS: readonly PredicateKind[] = [
  "toolCalledWith",
  "toolCalledAtLeastOnce",
  "toolNeverCalled",
  "firstToolWas",
  "responseContains",
  "responseMatches",
  "noToolErrors",
  "finalAssistantMessageNonEmpty",
  "tokenBudgetUnder",
  "turnCountUnder",
  "widgetRendered",
  "widgetRenderLatencyUnder",
  "widgetNoConsoleErrors",
];

/**
 * The kinds to offer, given what the backend said it accepts.
 *
 * `undefined` (an older deployment, or capabilities that failed to load) ⇒ the
 * legacy set. A kind the client does not know is dropped: advertising it does
 * not teach this build how to author it.
 */
export function authorablePredicateKinds(
  advertised: readonly string[] | undefined,
): readonly PredicateKind[] {
  if (!advertised) return LEGACY_PREDICATE_KINDS;
  const accepted = new Set(advertised);
  return (PREDICATE_KINDS as readonly PredicateKind[]).filter((kind) =>
    accepted.has(kind),
  );
}

export type { ScorerUiRole };

/**
 * What each tier means, in the reader's terms: what happens to the test.
 *
 * The two entries replace Gate / Warn / Report. Warn and Report said the same
 * thing about the iteration — neither failed it — and differed only by an
 * amber highlight, so a reader had to learn a distinction the verdict never
 * made. `severity: "warn"` is still accepted on the wire and still renders its
 * highlight where one exists; it no longer names a tier.
 */
export const ROLE_LEGEND: Record<
  ScorerUiRole,
  { label: string; meaning: string }
> = {
  required: {
    label: "Required",
    meaning: "If this assertion fails, the iteration fails.",
  },
  advisory: {
    label: "Advisory",
    meaning: "Shown on the result. Never fails the iteration.",
  },
};

/**
 * Authored role a settings row can write.
 *
 * Required is the default: both policy fields stripped, so a saved check looks
 * like every check written before roles existed. `severity` is ignored here —
 * an advisory check reads as Advisory whether or not it carries one, which is
 * what collapsing Warn into Report means.
 */
export function roleOfPredicate(predicate: Predicate): ScorerUiRole {
  return checkRole(predicate) === "advisory" ? "advisory" : "required";
}

export function withPredicateRole(
  predicate: Predicate,
  role: ScorerUiRole,
): Predicate {
  const { role: _role, severity: _severity, ...rest } = predicate;
  // Required writes the stored form Gate always had — both fields absent — so
  // a row switched to Required is byte-identical to one authored before roles
  // existed, and its configuration revision does not move.
  if (role === "required") return rest as Predicate;
  // A NEW advisory write carries no `severity`: it no longer decides a label,
  // and the reducer only rewrites rows the author touched, so an untouched
  // row keeps whatever severity it was stored with.
  return { ...(rest as Predicate), role: "advisory" };
}

export type JudgeSlot = "goalCompletion" | "groundedness" | "rubricChecks";

/**
 * Groundedness and rubric checks cannot gate. Goal completion follows the
 * stored role.
 */
export function roleOfJudgeSlot(
  slot: JudgeSlot,
  judgeConfig: EvalJudgeConfig | undefined,
): ScorerUiRole {
  if (slot === "groundedness" || slot === "rubricChecks") return "advisory";
  // Either spelling: a suite configured before the rename stores `"gating"`
  // and one configured after stores `"required"`, and this table renders both.
  return isRequiredRole(judgeConfig?.goalCompletion?.role)
    ? "required"
    : "advisory";
}

/**
 * Authored goal-completion role a settings row can write.
 *
 * Writes the spelling this build emits, which is the canonical one now that
 * the boundary takes it. Deliberately NOT capability-gated: the client and the
 * server it writes to are one deployment, unlike an SDK runner in somebody's
 * CI — and a deployment that shipped this build shipped the boundary with it.
 */
export function withGoalCompletionRole(
  current: NonNullable<EvalJudgeConfig["goalCompletion"]>,
  role: ScorerUiRole,
): NonNullable<EvalJudgeConfig["goalCompletion"]> {
  const { role: _role, severity: _severity, ...rest } = current;
  if (role === "required") return { ...rest, role: authoredRequiredRole() };
  return { ...rest, role: "advisory" };
}

export type ScorerLibraryCategoryId =
  "discovery" | "selection" | "call" | "userValue" | "budget" | "response";

/**
 * `as const satisfies` rather than a `Record<_, string>` annotation: the
 * exhaustiveness check is the same, but the literal value types survive, which
 * is what lets the Add drawer derive a real union of section headings from
 * these instead of widening to `string`.
 */
export const SCORER_LIBRARY_CATEGORY_LABELS = {
  discovery: "Discovery",
  selection: "Selection",
  call: "Tool call",
  userValue: "User value",
  budget: "Budgets",
  response: "Response",
} as const satisfies Record<ScorerLibraryCategoryId, string>;

/**
 * Chain order, then the budget group: the same six-stage order the run page
 * reports in, so a reader picks an assertion from the heading its evidence
 * will appear under.
 */
export const LIBRARY_CATEGORY_ORDER: readonly ScorerLibraryCategoryId[] = [
  "discovery",
  "selection",
  "call",
  "response",
  "userValue",
  "budget",
];

/**
 * Where a kind appears in the Add-scorer library.
 *
 * Budgets are a presentation group (`GRADER_PRESENTATION_GROUP`) that still
 * file at `userValue` analytically. The library lists them separately so a
 * ceiling is not offered beside "did the answer contain the right thing".
 */
export function libraryCategoryOfKind(
  kind: PredicateKind,
): ScorerLibraryCategoryId {
  if (GRADER_PRESENTATION_GROUP[kind] === "budget") return "budget";
  const stage = PREDICATE_STAGE[kind];
  if (stage === "discovery") return "discovery";
  if (stage === "selection") return "selection";
  if (stage === "call") return "call";
  if (stage === "response") return "response";
  return "userValue";
}

export type ScorerLibraryCategory = {
  id: ScorerLibraryCategoryId;
  label: string;
  kinds: readonly PredicateKind[];
};

/**
 * Library sections that actually have kinds.
 *
 * Response is reserved for a later release — an empty section would ask a
 * person to pick from nothing. Categories are listed only when they have
 * at least one kind.
 */
/**
 * Kinds no surface offers unless it asks for them by name.
 *
 * `onlyToolsCalled` generalizes the tool-call matcher's exclusivity option and
 * the case-level negative flag into one check. Both of those still exist and
 * still work, so offering this beside them on the suite settings page or the
 * pre-spine case page would give a reader two controls for one claim with no
 * way to tell which wins. It is offered only where it REPLACES them — the
 * Evaluate spine, via {@link spineLibraryKinds}.
 *
 * The kind is readable and editable everywhere regardless; this governs where
 * it can be ADDED.
 */
export const LIBRARY_OPT_IN_KINDS: ReadonlySet<PredicateKind> =
  new Set<PredicateKind>(["onlyToolsCalled"]);

export function scorerLibraryCategories(
  kinds: readonly PredicateKind[] = PREDICATE_KINDS.filter(
    (kind) => !LIBRARY_OPT_IN_KINDS.has(kind),
  ),
): ScorerLibraryCategory[] {
  const buckets: Record<ScorerLibraryCategoryId, PredicateKind[]> = {
    discovery: [],
    selection: [],
    call: [],
    userValue: [],
    budget: [],
    response: [],
  };
  for (const kind of kinds) {
    buckets[libraryCategoryOfKind(kind)].push(kind);
  }
  return LIBRARY_CATEGORY_ORDER.filter((id) => buckets[id].length > 0).map(
    (id) => ({
      id,
      label: SCORER_LIBRARY_CATEGORY_LABELS[id],
      kinds: buckets[id],
    }),
  );
}

export type ScorerTableRowKind =
  "observed" | "match" | "predicate" | "judge" | "preset";

/**
 * A standard-check family a row belongs to, when its kind backs one.
 *
 * `suiteRules` is how many of the suite's rules share the kind: a case turns
 * a family off as a whole, so a row that would hide two other rules says so.
 */
export type ScorerTableFamily = {
  id: AssertionCheck["id"];
  name: string;
  label: string;
  suiteRules: number;
};

export type ScorerTableRow = {
  id: string;
  kind: ScorerTableRowKind;
  /**
   * The On column. Always true for an observed or match row (there is no
   * control), false for a `preset` row (nothing authored yet) and for a suite
   * rule the case suppressed.
   */
  enabled: boolean;
  /** Which list a `predicate` row is stored in. Absent for every other kind. */
  source?: RuleSource;
  /** A suite rule the case turned off. Listed so it can be turned back on. */
  suppressed?: boolean;
  family?: ScorerTableFamily;
  /** The rule a `preset` row would author when switched on. */
  preset?: Predicate;
  /** Scorer column — name, plus `formatCriterion` for a predicate. */
  name: string;
  kindLabel: string;
  /**
   * Threshold cell. `"1"` is the fixed pass for a check or match row.
   * Budgets carry the authored ceiling; the judge carries its score bar.
   */
  threshold: string;
  thresholdKind: "fixed" | "budget" | "judge" | "none";
  role: ScorerUiRole;
  muted: boolean;
  predicateIndex?: number;
  matchField?: GraderRow["matchField"];
  judgeSlot?: JudgeSlot;
  observedStage?: UserValueStage;
};

export type ScorerTableGroup = {
  stage: UserValueStage;
  ordinal: string;
  label: string;
  question: string;
  rows: ScorerTableRow[];
};

export type ScorerTableView = {
  groups: ScorerTableGroup[];
  cards: StageCardView[];
};

const STAGE_CONFIG_CHIP_LABEL: Record<StageConfigState["state"], string> = {
  runner: "Observed by the runner",
  gated: "Required",
  gap: "No evaluator",
  judgeOnRequest: "Judge on request",
  judgeAutomatic: "Judge automatic",
  judgeOff: "Judge off",
  judgeUnknown: "Grading state unavailable",
};

/**
 * "N required · M advisory", or "" when nothing is authored.
 *
 * Takes the counters structurally rather than a whole {@link StageConfigState}
 * so a case's `StageCoverage` can be passed directly — the suite card and the
 * case card render the same sentence, and neither needs a cast to say so.
 */
export function formatStageConfigLine(state: {
  required: number;
  advisory: number;
}): string {
  const parts: string[] = [];
  if (state.required > 0) parts.push(`${state.required} required`);
  if (state.advisory > 0) parts.push(`${state.advisory} advisory`);
  return parts.join(" · ");
}

function matchKindLabel(field: GraderRow["matchField"]): string {
  if (field === "argumentMatching") return "Arguments";
  if (field === "toolCallOrder") return "Order";
  if (field === "maxExtraToolCalls") return "Extras";
  return "Match";
}

function predicateKindLabel(predicate: Predicate): string {
  return (
    PREDICATE_KIND_LABELS[
      predicate.type as keyof typeof PREDICATE_KIND_LABELS
    ] ?? String(predicate.type)
  );
}

/**
 * The number the Threshold cell shows for a ceiling-shaped check.
 *
 * `"1"` is the fixed pass for everything else: a check either holds or it does
 * not, and showing "1" says so without pretending there is a knob.
 */
function budgetThreshold(predicate: Predicate): string {
  if (predicate.type === "toolDescriptionsPresent")
    return String(predicate.minLength ?? 20);
  if (predicate.type === "tokenBudgetUnder") return String(predicate.tokens);
  if (predicate.type === "turnCountUnder") return String(predicate.turns);
  if (predicate.type === "toolLatencyUnder") return String(predicate.ms);
  if (predicate.type === "toolResultSizeUnder")
    return String(predicate.maxBytes);
  if (predicate.type === "toolCallCountUnder") return String(predicate.count);
  return "1";
}

/**
 * True when the row's verdict turns on a number the author set.
 *
 * NOT the same question as the Budgets presentation GROUP. `toolLatencyUnder`
 * and `toolResultSizeUnder` are ceilings, so their Threshold cell shows the
 * ceiling — but they are filed at `response` and belong under Response on the
 * page, where an author reads them next to the other facts about what the
 * server answered with. Conflating the two would move them into Budgets.
 */
function hasAuthoredThreshold(predicate: Predicate): boolean {
  return (
    predicate.type === "toolDescriptionsPresent" ||
    predicate.type === "tokenBudgetUnder" ||
    predicate.type === "turnCountUnder" ||
    predicate.type === "toolLatencyUnder" ||
    predicate.type === "toolResultSizeUnder" ||
    predicate.type === "toolCallCountUnder"
  );
}

/**
 * What the runner measures at a stage without any authored assertion: named
 * like one ("Successful connection"), because that is how it reads beside the
 * assertions, but never a box — it is on for every iteration and cannot be
 * turned off.
 */
export const RUNNER_MEASUREMENT_LABELS: Record<UserValueStage, string> = {
  connection: STANDARD_CHECKS.find(
    (check) => check.id === "connection.success",
  )!.name,
  discovery: STANDARD_CHECKS.find(
    (check) => check.id === "discovery.toolsList",
  )!.name,
  selection: "A tool was selected",
  call: "Tool call completed",
  response: "Result returned to the model",
  userValue: "Observed by the runner",
};

function observedRow(stage: UserValueStage): ScorerTableRow {
  return {
    id: `observed:${stage}`,
    kind: "observed",
    enabled: true,
    name: RUNNER_MEASUREMENT_LABELS[stage],
    kindLabel: "Runner",
    threshold: "",
    thresholdKind: "none",
    role: "advisory",
    muted: true,
    observedStage: stage,
  };
}

function matchTableRow(row: GraderRow): ScorerTableRow {
  return {
    id: row.id,
    kind: "match",
    enabled: true,
    name: row.label,
    kindLabel: matchKindLabel(row.matchField),
    threshold: "1",
    thresholdKind: "fixed",
    role: "required",
    muted: false,
    matchField: row.matchField,
  };
}

function familyOf(
  predicate: Predicate,
  rules: EffectiveRule[],
): ScorerTableFamily | undefined {
  const check = standardCheckOfKind(predicate.type);
  if (!check) return undefined;
  return {
    id: check.id,
    name: check.name,
    label: check.label,
    suiteRules: rules.filter(
      (rule) =>
        rule.source === "suite" && rule.predicate.type === check.preset.type,
    ).length,
  };
}

function predicateTableRow(
  row: GraderRow,
  rules: EffectiveRule[],
): ScorerTableRow | null {
  if (row.predicateIndex === undefined) return null;
  const rule = rules[row.predicateIndex];
  if (!rule) return null;
  const { predicate } = rule;
  const budget = hasAuthoredThreshold(predicate);
  return {
    id: row.id,
    kind: "predicate",
    enabled: !rule.suppressed,
    source: rule.source,
    suppressed: rule.suppressed,
    family: familyOf(predicate, rules),
    name: formatCriterion({ predicate }),
    kindLabel: predicateKindLabel(predicate),
    threshold: budget ? budgetThreshold(predicate) : "1",
    thresholdKind: budget ? "budget" : "fixed",
    role: roleOfPredicate(predicate),
    muted: rule.suppressed,
    predicateIndex: row.predicateIndex,
  };
}

/**
 * A standard check nothing in the list authors yet: off, with the preset's
 * criterion and role shown so switching it on is not a surprise.
 */
function presetTableRow(check: AssertionCheck): ScorerTableRow {
  const { preset } = check;
  return {
    id: `preset:${check.id}`,
    kind: "preset",
    enabled: false,
    family: {
      id: check.id,
      name: check.name,
      label: check.label,
      suiteRules: 0,
    },
    preset,
    name: formatCriterion({ predicate: preset }),
    kindLabel: predicateKindLabel(preset),
    threshold: hasAuthoredThreshold(preset) ? budgetThreshold(preset) : "1",
    thresholdKind: "none",
    role: roleOfPredicate(preset),
    muted: true,
  };
}

function judgeTableRow(
  row: GraderRow,
  judgeConfig: EvalJudgeConfig | undefined,
  judgeEnabled: boolean,
): ScorerTableRow {
  const slot: JudgeSlot = row.judgeSlot ?? "goalCompletion";
  if (slot === "rubricChecks") {
    // The row's own switch. Rubric checks ride the goal-completion judge, so
    // with that judge off they do not run whatever this says; the table
    // disables the box and says why rather than rewriting the stored value.
    return {
      id: row.id,
      kind: "judge",
      enabled: judgeConfig?.rubricChecks?.enabled !== false,
      name: row.label,
      kindLabel: "Judge",
      threshold: "",
      thresholdKind: "none",
      role: roleOfJudgeSlot("rubricChecks", judgeConfig),
      muted: false,
      judgeSlot: "rubricChecks",
    };
  }
  if (slot === "groundedness") {
    return {
      id: row.id,
      kind: "judge",
      enabled: true,
      name: row.label,
      kindLabel: "Judge",
      threshold: "",
      thresholdKind: "none",
      role: roleOfJudgeSlot("groundedness", judgeConfig),
      muted: false,
      judgeSlot: "groundedness",
    };
  }
  const threshold = judgeConfig?.goalCompletion?.threshold;
  return {
    id: row.id,
    kind: "judge",
    enabled: judgeEnabled,
    name: row.label,
    kindLabel: "Judge",
    threshold: threshold === undefined ? "" : String(threshold),
    thresholdKind: "judge",
    role: roleOfJudgeSlot("goalCompletion", judgeConfig),
    muted: false,
    judgeSlot: "goalCompletion",
  };
}

/**
 * This stage's standard checks, in catalog order, whether or not they are on.
 *
 * An enabled check used to leave the catalog and sit above every check still
 * off, so ticking one moved it to the top of the stage. It stays in its slot
 * instead. A family that already has a rule — including one the case
 * suppressed — fills that slot, so the person sees the rule they turned off
 * and not a second, fresh copy of the catalog entry beside it.
 */
function catalogRowsForStage(
  stage: UserValueStage,
  familyRows: ReadonlyMap<string, readonly ScorerTableRow[]>,
  listPresets: boolean,
): ScorerTableRow[] {
  const rows: ScorerTableRow[] = [];
  for (const check of STANDARD_ASSERTION_CHECKS) {
    if (check.stage !== stage) continue;
    const listed = familyRows.get(check.id);
    if (listed && listed.length > 0) {
      rows.push(...listed);
      continue;
    }
    if (listPresets) rows.push(presetTableRow(check));
  }
  return rows;
}

function placePredicateRow(
  row: GraderRow,
  rules: EffectiveRule[],
  familyRows: Map<string, ScorerTableRow[]>,
  loose: ScorerTableRow[],
) {
  const next = predicateTableRow(row, rules);
  if (!next) return;
  const familyId = next.family?.id;
  if (!familyId) {
    loose.push(next);
    return;
  }
  const bucket = familyRows.get(familyId) ?? [];
  bucket.push(next);
  familyRows.set(familyId, bucket);
}

function rowsForStage(
  stage: UserValueStage,
  model: SuiteGradingModel,
  rules: EffectiveRule[],
  judgeConfig: EvalJudgeConfig | undefined,
  judgeEnabled: boolean,
  listPresets: boolean,
): ScorerTableRow[] {
  const authored = model.byStage[stage];
  const rows: ScorerTableRow[] = [];
  const familyRows = new Map<string, ScorerTableRow[]>();
  const loosePredicates: ScorerTableRow[] = [];

  if (stage === "connection" || stage === "discovery") {
    rows.push(observedRow(stage));
    if (stage === "connection") return rows;
  }

  if (stage === "call") {
    const argument = authored.find(
      (row) => row.matchField === "argumentMatching",
    );
    if (argument) rows.push(matchTableRow(argument));
    else rows.push(observedRow(stage));
    for (const row of authored) {
      if (row.kind === "predicate") {
        placePredicateRow(row, rules, familyRows, loosePredicates);
      }
    }
    return [
      ...rows,
      ...loosePredicates,
      ...catalogRowsForStage(stage, familyRows, listPresets),
    ];
  }

  for (const row of authored) {
    if (row.kind === "match") rows.push(matchTableRow(row));
    else if (row.kind === "predicate") {
      placePredicateRow(row, rules, familyRows, loosePredicates);
    } else if (row.kind === "judge") {
      rows.push(judgeTableRow(row, judgeConfig, judgeEnabled));
    }
  }

  const catalog = catalogRowsForStage(stage, familyRows, listPresets);
  if (
    rows.length === 0 &&
    loosePredicates.length === 0 &&
    catalog.length === 0 &&
    !stageEmptyIsGap(stage)
  ) {
    rows.push(observedRow(stage));
  }

  return [...rows, ...loosePredicates, ...catalog];
}

function configCard(state: StageConfigState, index: number): StageCardView {
  const line = formatStageConfigLine(state);
  return {
    stage: state.stage,
    ordinal: String(index + 1).padStart(2, "0"),
    label: USER_VALUE_STAGE_LABELS[state.stage],
    chip: {
      kind: "unmeasured",
      label: STAGE_CONFIG_CHIP_LABEL[state.state],
      toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
    },
    ...(line
      ? {
          detail: {
            label: line,
            toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
          },
        }
      : {}),
  };
}

/**
 * The table and the chain cards, from the same grading model.
 *
 * `model` must be grouped over `predicates` in order — row indexes point into
 * that list. `rules` carries each predicate's source and suppression; absent,
 * every predicate is the suite's own. `activeModel` is grouped over only the
 * rules that will run, for the cards: a suppressed rule is listed but must
 * not be counted as a gate or a warn.
 *
 * `judgeCapabilities` is accepted so a later slice can hide a judge slot
 * the deployment does not run; this release always lists goal completion.
 */
export function buildScorerTable(input: {
  model: SuiteGradingModel;
  predicates: Predicate[];
  rules?: EffectiveRule[];
  activeModel?: SuiteGradingModel;
  judgeConfig?: EvalJudgeConfig;
  /** Overrides the judge row's On state; a case's judge-skipped flag. */
  judgeEnabled?: boolean;
  judgeCapabilities?: SuiteCapabilities["judge"];
  judgePolicy?: GoalJudgePolicy;
  /** List the standard checks nothing authors yet as off rows. Default on. */
  listPresets?: boolean;
}): ScorerTableView {
  void input.judgeCapabilities;
  const rules =
    input.rules ??
    input.predicates.map((predicate, index): EffectiveRule => ({
      predicate,
      source: "suite",
      index,
      suppressed: false,
    }));
  // A case can skip the judge, never switch on one the suite turned off.
  const configuredMode = judgeMode(input.judgeConfig, input.judgePolicy);
  const judgeEnabled = configuredMode !== "off" && (input.judgeEnabled ?? true);
  const mode: JudgeMode = judgeEnabled ? configuredMode : "off";
  const groups = USER_VALUE_STAGES.map((stage, index) => ({
    stage,
    ordinal: String(index + 1).padStart(2, "0"),
    label: USER_VALUE_STAGE_LABELS[stage],
    question: USER_VALUE_STAGE_QUESTIONS[stage],
    rows: rowsForStage(
      stage,
      input.model,
      rules,
      input.judgeConfig,
      judgeEnabled,
      input.listPresets ?? true,
    ),
  }));
  const states = stageConfigStates(input.activeModel ?? input.model, mode);
  const cards = states.map((state, index) => configCard(state, index));
  return { groups, cards };
}
