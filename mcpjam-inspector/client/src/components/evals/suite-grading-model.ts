/**
 * Which stage of the user-value chain each of a suite's graders measures.
 *
 * THE PROBLEM THIS SOLVES. The settings sheet listed "Tool calls", "Default
 * checks", "Minimum accuracy" and "LLM as Judge" as four unrelated rows. Read
 * top to bottom they describe four features; what they actually describe is
 * one question asked at six different points of a trial's journey — did the
 * client connect, discover, select, call, respond, and deliver value. A person
 * looking at that page could not answer "which parts of my server does this
 * suite check?", because the page was organized by the shape of the storage
 * rather than by the shape of the thing being measured.
 *
 * So this module answers exactly that, and nothing else. It takes a suite's
 * three grader sources — the tool-call matcher, the authored predicates, and
 * the hosted judge — and files each one under the stage it measures.
 *
 * TWO RULES KEEP IT HONEST.
 *
 *   1. The routing is NOT decided here. `PREDICATE_STAGE`, `GRADER_STAGE` and
 *      `GRADER_PRESENTATION_GROUP` come from `@mcpjam/sdk/contract`, where the
 *      analyzer's own selection routing is derived from the same table. A
 *      second copy in the client is a second opinion, and the one that
 *      disagrees with the analyzer is the one on the settings page.
 *   2. Nothing here decides a VERDICT, a stage STATE, or a rate. This is
 *      configuration — "what will be measured" — and the run-state vocabulary
 *      (`STAGE_STATE_LABELS`, and `notMeasured` in particular) describes
 *      something that happened. A settings page that borrows "not measured"
 *      claims an observation nobody made.
 *
 * TOTAL AND NON-THROWING. Every predicate kind the schema admits lands in
 * exactly one group, and a kind this build does not know lands at `userValue`
 * with its raw type as the label rather than throwing — a settings page that
 * blanks out because the backend shipped a new predicate first is a worse
 * failure than one that shows an unfamiliar row.
 */

import {
  GRADER_PRESENTATION_GROUP,
  GRADER_STAGE,
  PREDICATE_STAGE,
  USER_VALUE_STAGES,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import {
  MATCH_OPTIONS_DEFAULTS,
  resolveMatchOptions,
} from "@/shared/eval-matching";
import { checkRole, checkSeverity, type Predicate } from "@mcpjam/sdk/predicates";
import {
  formatCriterion,
  PREDICATE_KIND_LABELS,
} from "@/shared/predicate-kinds";
import { ARGS_OPTIONS, ORDER_OPTIONS } from "./validators-section";
import type { EvalJudgeConfig } from "./types";

/** Which of the suite's three grader sources a row came from. */
export type GraderRowKind = "match" | "predicate" | "judge";

/**
 * One grader, as the settings page shows it.
 *
 * `role` is DERIVED. Match rules are always gates. A predicate's role is
 * `checkRole(predicate)` — absent means gating; only the literal `"advisory"`
 * is advisory. The judge's role is whatever `judgeConfig.goalCompletion.role`
 * says, defaulting to advisory.
 */
export type GraderRow = {
  /** Stable within one render; used as a React key, not persisted. */
  id: string;
  kind: GraderRowKind;
  /** One line a reader can match to the control that edits it. */
  label: string;
  role: "gating" | "advisory";
  /** Authored warn severity, only meaningful on an advisory predicate. */
  severity?: "warn";
  /** Index into `defaultPredicates`, for a predicate row. */
  predicateIndex?: number;
  /** Which match-options field a `match` row came from. */
  matchField?: "toolCallOrder" | "maxExtraToolCalls" | "argumentMatching";
  /** Which judge slot a `judge` row came from. */
  judgeSlot?: "goalCompletion" | "groundedness";
};

export type SuiteGradingModel = {
  /** Every stage, always — an empty list is the answer "nothing here". */
  byStage: Record<UserValueStage, GraderRow[]>;
  /**
   * Token and turn ceilings, lifted out of `userValue` for READING ONLY.
   *
   * They file at `userValue` analytically (`GRADER_PRESENTATION_GROUP` is the
   * source, and it carries no analytical weight); reading them beside "did the
   * answer contain the right thing" makes neither legible.
   */
  budgets: GraderRow[];
};

const ORDER_LABEL = new Map(
  ORDER_OPTIONS.map((option) => [option.value, option.label]),
);
const ARGS_LABEL = new Map(
  ARGS_OPTIONS.map((option) => [option.value, option.label]),
);

/**
 * The suite layer's effective match options.
 *
 * ONE layer, deliberately: `resolveMatchOptions(suite, case, runOverride)`
 * takes three, and passing `MATCH_OPTIONS_DEFAULTS` as the second would layer
 * the defaults ON TOP of the suite's own pins — quietly reporting "Any order"
 * for a suite that pins strict ordering. Cases and per-run overrides relax
 * these further at run time, which the section's hint says and this model does
 * not pretend to know.
 *
 * The resolver ASSERTS its result, and a stored value from a future build
 * could fail that assertion. Falling back to the defaults keeps a settings page
 * readable instead of blanking it — the row is then wrong about one field,
 * which is strictly better than the page being wrong about all of them.
 */
function resolveSuiteMatchOptions(
  matchOptions: EvalMatchOptions | undefined,
): Required<Omit<EvalMatchOptions, "allowExtraToolCalls">> {
  try {
    return resolveMatchOptions(matchOptions);
  } catch {
    return { ...MATCH_OPTIONS_DEFAULTS };
  }
}

function emptyByStage(): Record<UserValueStage, GraderRow[]> {
  return Object.fromEntries(
    USER_VALUE_STAGES.map((stage) => [stage, [] as GraderRow[]]),
  ) as Record<UserValueStage, GraderRow[]>;
}

/**
 * The tool-call matcher, as up to three rows.
 *
 * The matcher is ONE stored object but THREE separate judgements, and they do
 * not measure the same link: order and extra calls are about which tools the
 * model reached for (`selection`), while argument matching is about whether the
 * call it made was usable (`call`). Rendering the object as a single row under
 * one stage would file half of it in the wrong place.
 *
 * Rows are built from the RESOLVED options, so a suite that pins nothing still
 * shows what it is actually graded against — an empty `selection` group on a
 * suite the runner is happily order-checking would be a lie of omission.
 */
function matchRows(matchOptions: EvalMatchOptions | undefined): GraderRow[] {
  const resolved = resolveSuiteMatchOptions(matchOptions);
  const rows: GraderRow[] = [
    {
      id: "match:toolCallOrder",
      kind: "match",
      label: `Tool call order — ${
        ORDER_LABEL.get(resolved.toolCallOrder) ?? resolved.toolCallOrder
      }`,
      role: "gating",
      matchField: "toolCallOrder",
    },
    {
      id: "match:maxExtraToolCalls",
      kind: "match",
      label:
        resolved.maxExtraToolCalls === null
          ? "Extra tool calls — unlimited"
          : `Extra tool calls — at most ${resolved.maxExtraToolCalls}`,
      role: "gating",
      matchField: "maxExtraToolCalls",
    },
  ];
  return rows;
}

/** The argument-matching row, which files at `call` rather than `selection`. */
function argumentRow(matchOptions: EvalMatchOptions | undefined): GraderRow {
  const resolved = resolveSuiteMatchOptions(matchOptions);
  return {
    id: "match:argumentMatching",
    kind: "match",
    label: `Arguments — ${
      ARGS_LABEL.get(resolved.argumentMatching) ?? resolved.argumentMatching
    }`,
    role: "gating",
    matchField: "argumentMatching",
  };
}

/**
 * Group a suite's graders by the stage each one measures.
 *
 * Pure and cheap: it reads a suite's draft values and returns a rendering
 * model. It performs no I/O, holds no state, and never looks at a run.
 */
export function groupGradersByStage(input: {
  matchOptions?: EvalMatchOptions;
  predicates: Predicate[];
  judgeConfig?: EvalJudgeConfig;
}): SuiteGradingModel {
  const byStage = emptyByStage();
  const budgets: GraderRow[] = [];

  for (const row of matchRows(input.matchOptions)) {
    byStage[GRADER_STAGE["toolCalls:match"]].push(row);
  }
  byStage.call.push(argumentRow(input.matchOptions));

  input.predicates.forEach((predicate, index) => {
    const kind = predicate.type as keyof typeof PREDICATE_STAGE;
    const label =
      kind in PREDICATE_KIND_LABELS
        ? formatCriterion({ predicate })
        : String(predicate.type);
    const row: GraderRow = {
      id: `predicate:${index}`,
      kind: "predicate",
      label,
      role: checkRole(predicate),
      severity: checkSeverity(predicate),
      predicateIndex: index,
    };
    if (GRADER_PRESENTATION_GROUP[kind] === "budget") {
      budgets.push(row);
      return;
    }
    // An unknown kind files at `userValue` rather than throwing: the last link
    // is where "we could not place this" does the least damage, since it is
    // already the catch-all the contract routes its own unsplit evidence to.
    byStage[PREDICATE_STAGE[kind] ?? "userValue"].push(row);
  });

  // Always inserted, even when the judge is off. This row is the control
  // the Pass or fail body lists — it is not a claim that the suite judges.
  // Read `judgeMode(judgeConfig)` for whether a judge actually runs.
  byStage[GRADER_STAGE["judge:goalCompletion"]].push({
    id: "judge:goalCompletion",
    kind: "judge",
    label: "Goal completion judge",
    role:
      input.judgeConfig?.goalCompletion?.role === "gating"
        ? "gating"
        : "advisory",
    severity: input.judgeConfig?.goalCompletion?.severity,
    judgeSlot: "goalCompletion",
  });
  byStage[GRADER_STAGE["judge:groundedness"]].push({
    id: "judge:groundedness",
    kind: "judge",
    label: "Groundedness judge",
    role: "advisory",
    severity: input.judgeConfig?.groundedness?.severity,
    judgeSlot: "groundedness",
  });

  return { byStage, budgets };
}

/**
 * What an empty stage group says.
 *
 * THREE ANSWERS, and the distinction is the point. `connection`, `discovery`
 * and `call` have no authorable grader on this page at all — the runner
 * measures them on every trial whether or not anyone configured anything — so
 * "no grader" would read as a gap the reader should close. The other three are
 * genuinely unconfigured.
 *
 * Neither answer is `STAGE_STATE_LABELS.notMeasured`. That phrase describes a
 * RUN: a stage no trial reached, or one the analyzer could not decide. Settings
 * is config state, and borrowing the run word here would put an observation on
 * a page that has observed nothing.
 */
export const STAGE_EMPTY_COPY: Record<UserValueStage, string> = {
  // "Nothing to configure" was false in the way that mattered: nothing to
  // GRADE, but the client and server rows decide whether these stages succeed,
  // and a reader debugging a failed connection was told to look nowhere. The
  // card now lists that configuration; this line says where it comes from.
  connection:
    "Observed by the runner — decided by the client and server connection settings",
  discovery:
    "Observed by the runner — decided by the client's discovery settings",
  selection: "No grader",
  call: "Observed by the runner — nothing to configure",
  response: "No grader",
  userValue: "No grader",
};

/** True when this stage's empty state is a gap rather than a runner concern. */
export function stageEmptyIsGap(stage: UserValueStage): boolean {
  return STAGE_EMPTY_COPY[stage] === "No grader";
}

/**
 * How the judge is configured, not what a run did.
 *
 * Absent config is `manual`: `enabled` defaults on and `autoRun` defaults off,
 * matching `judges-section.tsx`. `role` is only `gating` when the literal
 * `"gating"` is stored.
 */
export type JudgeMode = "off" | "manual" | "automatic" | "gating";

export function judgeMode(judgeConfig: EvalJudgeConfig | undefined): JudgeMode {
  const goal = judgeConfig?.goalCompletion;
  if (goal?.enabled === false) return "off";
  if (goal?.role === "gating") return "gating";
  if (goal?.autoRun === true) return "automatic";
  return "manual";
}

export type StageConfigState = {
  stage: UserValueStage;
  state:
    | "runner"
    | "gated"
    | "gap"
    | "judgeOnRequest"
    | "judgeAutomatic"
    | "judgeOff";
  /** Deterministic gating rows (match + predicate). The judge is excluded. */
  gates: number;
  /** Advisory predicates authored as Warn. The judge is excluded. */
  warn: number;
  /** Advisory predicates without warn severity. The judge is excluded. */
  report: number;
  /** Only on `userValue`. */
  judge?: JudgeMode;
};

export function stageConfigStates(
  model: SuiteGradingModel,
  judge: JudgeMode,
): StageConfigState[] {
  return USER_VALUE_STAGES.map((stage) => {
    const rows = model.byStage[stage].filter((row) => row.kind !== "judge");
    const gates = rows.filter((row) => row.role === "gating").length;
    const warn = rows.filter(
      (row) => row.role === "advisory" && row.severity === "warn",
    ).length;
    const report = rows.filter(
      (row) => row.role === "advisory" && row.severity !== "warn",
    ).length;
    if (stage !== "userValue") {
      if (gates >= 1) return { stage, state: "gated", gates, warn, report };
      if (!stageEmptyIsGap(stage)) {
        return { stage, state: "runner", gates, warn, report };
      }
      return { stage, state: "gap", gates, warn, report };
    }
    if (gates >= 1 || judge === "gating") {
      return { stage, state: "gated", gates, warn, report, judge };
    }
    if (judge === "automatic") {
      return { stage, state: "judgeAutomatic", gates, warn, report, judge };
    }
    if (judge === "manual") {
      return { stage, state: "judgeOnRequest", gates, warn, report, judge };
    }
    return { stage, state: "judgeOff", gates, warn, report, judge };
  });
}

/**
 * The predicate kinds the settings page presents as ceilings.
 *
 * Derived from `GRADER_PRESENTATION_GROUP` rather than listed here: the
 * contract already decides which kinds read as budgets, and a second list in
 * the client is a second opinion that drifts the first time a kind is added.
 */
export const BUDGET_PREDICATE_KINDS = Object.entries(GRADER_PRESENTATION_GROUP)
  .filter(([, group]) => group === "budget")
  .map(([kind]) => kind) as readonly Predicate["type"][];

export function isBudgetPredicate(predicate: Predicate): boolean {
  return (
    GRADER_PRESENTATION_GROUP[
      predicate.type as keyof typeof GRADER_PRESENTATION_GROUP
    ] === "budget"
  );
}

/**
 * Fold an edited budget sub-list back into the suite's whole check list.
 *
 * The Limits tab edits a FILTERED view — the two ceiling kinds — of the one
 * `defaultPredicates` array, so what comes back has to be re-seated rather
 * than appended: budgets keep the slots they already occupied, so a save
 * diffs as "this ceiling changed" instead of "every check moved". Slots run
 * out when a ceiling was removed (the extra slots are dropped) and run over
 * when one was added (the new ones land at the end, where a new check goes).
 * Every non-budget check keeps its exact position, untouched.
 */
export function mergeBudgetPredicates(
  all: Predicate[],
  nextBudgets: Predicate[],
): Predicate[] {
  const merged: Predicate[] = [];
  let next = 0;
  for (const predicate of all) {
    if (isBudgetPredicate(predicate)) {
      if (next < nextBudgets.length) merged.push(nextBudgets[next++]);
      continue;
    }
    merged.push(predicate);
  }
  for (; next < nextBudgets.length; next++) merged.push(nextBudgets[next]);
  return merged;
}
