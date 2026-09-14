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
 * disagree about how many gates a stage has.
 */

import { stageEmptyIsGap } from "@/components/evals/suite-grading-model";
import { formatStageConfigLine } from "@/components/evals/suite-scorer-table-model";
import { STAGE_CHIP_TONE_CLASS } from "../stage-chain-model";
import type { UserValueStage } from "@mcpjam/sdk/contract";
import { USER_VALUE_STAGES } from "@mcpjam/sdk/contract";
import type { CaseScorecard } from "./case-scorecard-model";
import type { Suggestion } from "./suggest-from-run";

export type StageCoverage = {
  gates: number;
  warn: number;
  report: number;
  /** The judge grades this stage on this case. */
  judge: boolean;
  /** Nothing is authorable here — the runner observes it. */
  runner: boolean;
};

export type StageDetail = { label: string; toneClass: string };

export function coverageForCase(
  card: CaseScorecard,
): Record<UserValueStage, StageCoverage> {
  const out = {} as Record<UserValueStage, StageCoverage>;
  for (const stage of USER_VALUE_STAGES) {
    out[stage] = {
      gates: 0,
      warn: 0,
      report: 0,
      judge: false,
      runner: false,
    };
  }

  for (const group of card.groups) {
    for (const row of group.rows) {
      if (row.provenance === "judge") continue;
      // The route counts as one Selection gate only when it actually asserts
      // a route; "any route, graded by the checks below" asserts nothing.
      if (row.provenance === "route") {
        const kind = row.route?.kind;
        if (kind === "tools" || kind === "noTool") {
          out.selection.gates += 1;
        }
        continue;
      }
      const bucket = out[row.stage];
      if (!bucket) continue;
      if (row.role === "gate") bucket.gates += 1;
      else if (row.role === "warn") bucket.warn += 1;
      else bucket.report += 1;
    }
  }

  if (card.judge.judge?.runsForCase) out.userValue.judge = true;

  for (const stage of USER_VALUE_STAGES) {
    const entry = out[stage];
    const empty =
      entry.gates === 0 &&
      entry.warn === 0 &&
      entry.report === 0 &&
      !entry.judge;
    // The suite settings page's own rule for which links are observed rather
    // than authored, so a case and a suite agree about where a gap can exist.
    entry.runner = empty && !stageEmptyIsGap(stage);
  }

  return out;
}

export function coverageDetail(
  coverage: StageCoverage,
  suggestionsAtStage: number,
): StageDetail {
  if (coverage.runner) {
    return {
      label: "Observed by the runner",
      toneClass: STAGE_CHIP_TONE_CLASS.unmeasured,
    };
  }
  const configured = formatStageConfigLine(coverage as never);
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
