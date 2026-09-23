/**
 * What each link of the chain is actually graded by, on THIS case.
 *
 * The chain already says what happened; this says what would have caught it.
 * A link with nothing checking it is only worth flagging when something COULD
 * check it — a gap with no suggestion is just a link this release cannot
 * grade, and painting it amber on every case from day one teaches the reader
 * to ignore the colour.
 *
 * Counts come from the rows the scorecard already renders, never from a second
 * routing pass, so the line under a card and the list beside it cannot
 * disagree about how many required assertions a stage has.
 */

import { formatStageConfigLine } from "@/components/evals/suite-scorer-table-model";
import { STAGE_CHIP_TONE_CLASS } from "../stage-chain-model";
import type { UserValueStage } from "@mcpjam/sdk/contract";
import { USER_VALUE_STAGES } from "@mcpjam/sdk/contract";
import type { CaseScorecard } from "./case-scorecard-model";
import type { Suggestion } from "./suggest-from-run";

export type StageCoverage = {
  required: number;
  advisory: number;
  /** The judge grades this stage on this case. */
  judge: boolean;
  /**
   * Nothing authored grades this stage, and its built-in runner check does.
   * Read off the rows the scorecard renders, so a stage this case does not
   * exercise (no runner check) is not claimed as covered.
   */
  runner: boolean;
};

export type StageDetail = { label: string; toneClass: string };

export function coverageForCase(
  card: CaseScorecard,
): Record<UserValueStage, StageCoverage> {
  const out = {} as Record<UserValueStage, StageCoverage>;
  for (const stage of USER_VALUE_STAGES) {
    out[stage] = {
      required: 0,
      advisory: 0,
      judge: false,
      runner: false,
    };
  }

  const withRunnerCheck = new Set<UserValueStage>();
  for (const group of card.groups) {
    for (const row of group.rows) {
      if (row.provenance === "judge") continue;
      // Not an evaluator: it decides nothing, so it is not a rule to count.
      if (row.provenance === "builtin") {
        withRunnerCheck.add(row.stage);
        continue;
      }
      // The route counts as one required Selection rule only when it actually
      // asserts a route; "any route, graded by the checks below" asserts
      // nothing.
      if (row.provenance === "route") {
        const kind = row.route?.kind;
        if (kind === "tools" || kind === "noTool") {
          out.selection.required += 1;
        }
        continue;
      }
      const bucket = out[row.stage];
      if (!bucket) continue;
      if (row.role === "advisory") bucket.advisory += 1;
      else bucket.required += 1;
    }
  }

  // Coverage describes configured evaluators, even while scheduling policy is
  // loading or execution is paused. It does not promise a grading attempt.
  const judge = card.judge.judge;
  if (judge && judge.suiteMode !== "off" && !judge.skippedForCase) {
    out.userValue.judge = true;
  }

  for (const stage of USER_VALUE_STAGES) {
    const entry = out[stage];
    const empty =
      entry.required === 0 && entry.advisory === 0 && !entry.judge;
    entry.runner = empty && withRunnerCheck.has(stage);
  }

  return out;
}

export function coverageDetail(
  coverage: StageCoverage,
  suggestionsAtStage: number,
): StageDetail {
  if (coverage.runner) {
    // A runner check is not an assertion, so a suggestion still reads as the
    // gap it is — the runner check does not close it.
    return suggestionsAtStage > 0
      ? {
          label: `Built-in runner check · ${suggestionsAtStage} suggested`,
          toneClass: STAGE_CHIP_TONE_CLASS.mixed,
        }
      : {
          label: "Built-in runner check",
          toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
        };
  }
  const configured = formatStageConfigLine(coverage);
  if (configured || coverage.judge) {
    const parts = [configured, coverage.judge ? "judge" : ""].filter(Boolean);
    return {
      // Configuration, not measurement: the chip above already carries the
      // trial's tone, and tinting this line too would double-report it.
      label: parts.join(" · "),
      toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
    };
  }
  if (suggestionsAtStage > 0) {
    return {
      label: `No assertion here · ${suggestionsAtStage} suggested`,
      toneClass: STAGE_CHIP_TONE_CLASS.mixed,
    };
  }
  // A gap this release cannot fill. Neutral, because there is nothing to do.
  return {
    label: "No evaluator",
    toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
  };
}

export function coverageDetailByStage(
  card: CaseScorecard,
  suggestions: Suggestion[],
): Partial<Record<UserValueStage, StageDetail>> {
  const coverage = coverageForCase(card);
  const bySuggestion = new Map<UserValueStage, number>();
  for (const suggestion of suggestions) {
    bySuggestion.set(
      suggestion.stage,
      (bySuggestion.get(suggestion.stage) ?? 0) + 1,
    );
  }
  const out: Partial<Record<UserValueStage, StageDetail>> = {};
  for (const stage of USER_VALUE_STAGES) {
    out[stage] = coverageDetail(coverage[stage], bySuggestion.get(stage) ?? 0);
  }
  return out;
}
