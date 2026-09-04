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
import type { Predicate } from "@mcpjam/sdk/predicates";
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
 * `role` is DERIVED, never authored. Every predicate and every match rule is a
 * gate — that is what it means for the runner to grade against it — and the
 * judge's role is whatever `judgeConfig.goalCompletion.role` says, defaulting
 * to advisory. There is no per-predicate role to read, and inventing one here
 * would put a control on the page that the backend has no field for.
 */
export type GraderRow = {
  /** Stable within one render; used as a React key, not persisted. */
  id: string;
  kind: GraderRowKind;
  /** One line a reader can match to the control that edits it. */
  label: string;
  role: "gating" | "advisory";
  /** Index into `defaultPredicates`, for a predicate row. */
  predicateIndex?: number;
  /** Which match-options field a `match` row came from. */
  matchField?: "toolCallOrder" | "maxExtraToolCalls" | "argumentMatching";
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
    // OWN properties only. `in` walks the prototype chain, so a predicate
    // whose `type` is `__proto__` or `toString` passes the guard, and
    // `PREDICATE_STAGE[kind]` then returns an inherited value that is truthy
    // but not a stage — making `byStage[...]` undefined and the push throw.
    // An unrecognised kind has to degrade, not take the settings page down.
    const known = Object.prototype.hasOwnProperty.call(
      PREDICATE_KIND_LABELS,
      kind,
    );
    const label = known
      ? formatCriterion({ predicate })
      : String(predicate.type);
    const row: GraderRow = {
      id: `predicate:${index}`,
      kind: "predicate",
      label,
      // Every authored check is a gate. There is no per-predicate role on the
      // backend, so offering one here would be a control with nowhere to go.
      role: "gating",
      predicateIndex: index,
    };
    if (GRADER_PRESENTATION_GROUP[kind] === "budget") {
      budgets.push(row);
      return;
    }
    // An unknown kind files at `userValue` rather than throwing: the last link
    // is where "we could not place this" does the least damage, since it is
    // already the catch-all the contract routes its own unsplit evidence to.
    const stage = Object.prototype.hasOwnProperty.call(PREDICATE_STAGE, kind)
      ? PREDICATE_STAGE[kind]
      : undefined;
    byStage[stage ?? "userValue"].push(row);
  });

  // Only when the judge is actually on. A suite that turned it off measures
  // `userValue` with nothing, and saying otherwise is precisely the
  // misdescription this grouping exists to end. `undefined` still counts as
  // on: the field is optional and its absence has always meant the default.
  if (input.judgeConfig?.goalCompletion?.enabled !== false) {
    byStage[GRADER_STAGE["judge:goalCompletion"]].push({
      id: "judge:goalCompletion",
      kind: "judge",
      label: "Goal completion judge",
      role:
        input.judgeConfig?.goalCompletion?.role === "gating"
          ? "gating"
          : "advisory",
    });
  }

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
  connection: "Measured by the runner — nothing to configure",
  discovery: "Measured by the runner — nothing to configure",
  selection: "No grader",
  call: "Measured by the runner — nothing to configure",
  response: "No grader",
  userValue: "No grader",
};

/** True when this stage's empty state is a gap rather than a runner concern. */
export function stageEmptyIsGap(stage: UserValueStage): boolean {
  return STAGE_EMPTY_COPY[stage] === "No grader";
}
