/**
 * The Scorers table as configuration — what will grade each link of the chain.
 *
 * Pure. No rates, no run words, no I/O. `buildScorerTable` files every
 * authored check under the stage `PREDICATE_STAGE` already decided, and the
 * chain cards wear `stageConfigStates` rather than a verdict.
 */

import {
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
  checkSeverity,
  type Predicate,
} from "@mcpjam/sdk/predicates";
import {
  formatCriterion,
  PREDICATE_KIND_LABELS,
} from "@/shared/predicate-kinds";
import {
  STAGE_CHIP_TONE_CLASS,
  type StageCardView,
} from "@/components/evaluate/stage-chain-model";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type { EvalJudgeConfig } from "./types";
import {
  judgeMode,
  stageConfigStates,
  stageEmptyIsGap,
  type GraderRow,
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
 * kind an older validator rejects turns "Add scorer" into a save that fails,
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

export type ScorerUiRole = "gate" | "warn" | "report";

export const ROLE_LEGEND: Record<
  ScorerUiRole,
  { label: string; meaning: string }
> = {
  gate: {
    label: "Gate",
    meaning: "If this check fails, the iteration fails.",
  },
  warn: {
    label: "Warn",
    meaning:
      "If this check fails, a warning is shown without failing the iteration.",
  },
  report: {
    label: "Report",
    meaning:
      "Records the result for reference without changing the iteration verdict.",
  },
};

/**
 * Authored role a settings row can write.
 *
 * Gate is the default: both policy fields stripped, so a saved check looks
 * like every check written before roles existed. Warn is the only pairing
 * the schema admits for a highlight (`advisory` + `severity: "warn"`).
 * Report is advisory without a severity.
 */
export function roleOfPredicate(predicate: Predicate): ScorerUiRole {
  if (checkRole(predicate) === "gating") return "gate";
  return checkSeverity(predicate) === "warn" ? "warn" : "report";
}

export function withPredicateRole(
  predicate: Predicate,
  role: ScorerUiRole,
): Predicate {
  const { role: _role, severity: _severity, ...rest } = predicate;
  if (role === "gate") return rest as Predicate;
  if (role === "warn") {
    return { ...(rest as Predicate), role: "advisory", severity: "warn" };
  }
  return { ...(rest as Predicate), role: "advisory" };
}

export type JudgeSlot = "goalCompletion" | "groundedness";

/** Groundedness cannot gate. Goal completion follows the stored role. */
export function roleOfJudgeSlot(
  slot: JudgeSlot,
  judgeConfig: EvalJudgeConfig | undefined,
): ScorerUiRole {
  if (slot === "groundedness") {
    return judgeConfig?.groundedness?.severity === "warn" ? "warn" : "report";
  }
  const goal = judgeConfig?.goalCompletion;
  if (goal?.role === "gating") return "gate";
  return goal?.severity === "warn" ? "warn" : "report";
}

/** Authored goal-completion role a settings row can write. */
export function withGoalCompletionRole(
  current: NonNullable<EvalJudgeConfig["goalCompletion"]>,
  role: ScorerUiRole,
): NonNullable<EvalJudgeConfig["goalCompletion"]> {
  const { role: _role, severity: _severity, ...rest } = current;
  if (role === "gate") return { ...rest, role: "gating" };
  if (role === "warn") return { ...rest, role: "advisory", severity: "warn" };
  return { ...rest, role: "advisory" };
}

export type ScorerLibraryCategoryId =
  "selection" | "call" | "userValue" | "budget" | "response";

export const SCORER_LIBRARY_CATEGORY_LABELS: Record<
  ScorerLibraryCategoryId,
  string
> = {
  selection: "Selection",
  call: "Tool call",
  userValue: "User value",
  budget: "Budgets",
  response: "Response",
};

const LIBRARY_CATEGORY_ORDER: readonly ScorerLibraryCategoryId[] = [
  "selection",
  "call",
  "userValue",
  "budget",
  "response",
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

export type ScorerTableRowKind = "observed" | "match" | "predicate" | "judge";

export type ScorerTableRow = {
  id: string;
  kind: ScorerTableRowKind;
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
  gated: "Gated",
  gap: "No grader",
  judgeOnRequest: "Judge on request",
  judgeAutomatic: "Judge automatic",
  judgeOff: "Judge off",
};

export function formatStageConfigLine(state: StageConfigState): string {
  const parts: string[] = [];
  if (state.gates > 0) {
    parts.push(`${state.gates} ${state.gates === 1 ? "gate" : "gates"}`);
  }
  if (state.warn > 0) {
    parts.push(`${state.warn} warn`);
  }
  if (state.report > 0) {
    parts.push(`${state.report} ${state.report === 1 ? "report" : "reports"}`);
  }
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
    predicate.type === "tokenBudgetUnder" ||
    predicate.type === "turnCountUnder" ||
    predicate.type === "toolLatencyUnder" ||
    predicate.type === "toolResultSizeUnder" ||
    predicate.type === "toolCallCountUnder"
  );
}

function isBudgetRow(row: GraderRow, predicates: Predicate[]): boolean {
  if (row.predicateIndex === undefined) return false;
  const predicate = predicates[row.predicateIndex];
  return predicate !== undefined && hasAuthoredThreshold(predicate);
}

function observedRow(stage: UserValueStage): ScorerTableRow {
  return {
    id: `observed:${stage}`,
    kind: "observed",
    name: "Observed by the runner",
    kindLabel: "Runner",
    threshold: "",
    thresholdKind: "none",
    role: "report",
    muted: true,
    observedStage: stage,
  };
}

function matchTableRow(row: GraderRow): ScorerTableRow {
  return {
    id: row.id,
    kind: "match",
    name: row.label,
    kindLabel: matchKindLabel(row.matchField),
    threshold: "1",
    thresholdKind: "fixed",
    role: "gate",
    muted: false,
    matchField: row.matchField,
  };
}

function predicateTableRow(
  row: GraderRow,
  predicates: Predicate[],
): ScorerTableRow | null {
  if (row.predicateIndex === undefined) return null;
  const predicate = predicates[row.predicateIndex];
  if (!predicate) return null;
  const budget = isBudgetRow(row, predicates);
  return {
    id: row.id,
    kind: "predicate",
    name: formatCriterion({ predicate }),
    kindLabel: predicateKindLabel(predicate),
    threshold: budget ? budgetThreshold(predicate) : "1",
    thresholdKind: budget ? "budget" : "fixed",
    role: roleOfPredicate(predicate),
    muted: false,
    predicateIndex: row.predicateIndex,
  };
}

function judgeTableRow(
  row: GraderRow,
  judgeConfig: EvalJudgeConfig | undefined,
): ScorerTableRow {
  const slot: JudgeSlot = row.judgeSlot ?? "goalCompletion";
  if (slot === "groundedness") {
    return {
      id: row.id,
      kind: "judge",
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
    name: row.label,
    kindLabel: "Judge",
    threshold: threshold === undefined ? "" : String(threshold),
    thresholdKind: "judge",
    role: roleOfJudgeSlot("goalCompletion", judgeConfig),
    muted: false,
    judgeSlot: "goalCompletion",
  };
}

function rowsForStage(
  stage: UserValueStage,
  model: SuiteGradingModel,
  predicates: Predicate[],
  judgeConfig: EvalJudgeConfig | undefined,
): ScorerTableRow[] {
  const authored = model.byStage[stage];
  const rows: ScorerTableRow[] = [];

  if (stage === "connection" || stage === "discovery") {
    rows.push(observedRow(stage));
    return rows;
  }

  if (stage === "call") {
    const argument = authored.find(
      (row) => row.matchField === "argumentMatching",
    );
    if (argument) rows.push(matchTableRow(argument));
    else rows.push(observedRow(stage));
    for (const row of authored) {
      if (row.kind === "predicate") {
        const next = predicateTableRow(row, predicates);
        if (next) rows.push(next);
      }
    }
    return rows;
  }

  for (const row of authored) {
    if (row.kind === "match") rows.push(matchTableRow(row));
    else if (row.kind === "predicate") {
      const next = predicateTableRow(row, predicates);
      if (next) rows.push(next);
    } else if (row.kind === "judge") {
      rows.push(judgeTableRow(row, judgeConfig));
    }
  }

  if (rows.length === 0 && !stageEmptyIsGap(stage)) {
    rows.push(observedRow(stage));
  }

  return rows;
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
 * `judgeCapabilities` is accepted so a later slice can hide a judge slot
 * the deployment does not run; this release always lists goal completion.
 */
export function buildScorerTable(input: {
  model: SuiteGradingModel;
  predicates: Predicate[];
  judgeConfig?: EvalJudgeConfig;
  judgeCapabilities?: SuiteCapabilities["judge"];
}): ScorerTableView {
  void input.judgeCapabilities;
  const groups = USER_VALUE_STAGES.map((stage, index) => ({
    stage,
    ordinal: String(index + 1).padStart(2, "0"),
    label: USER_VALUE_STAGE_LABELS[stage],
    question: USER_VALUE_STAGE_QUESTIONS[stage],
    rows: rowsForStage(stage, input.model, input.predicates, input.judgeConfig),
  }));
  const states = stageConfigStates(input.model, judgeMode(input.judgeConfig));
  const cards = states.map((state, index) => configCard(state, index));
  return { groups, cards };
}
