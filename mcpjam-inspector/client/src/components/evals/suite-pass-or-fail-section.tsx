/**
 * "Pass or fail", organized by the stage each grader measures.
 *
 * THE PROBLEM THIS SOLVES. The settings sheet used to list Tool calls, Default
 * checks and LLM as Judge as three unrelated rows, in the order the fields
 * happen to be stored. A person could read the whole page and still not know
 * which parts of their server the suite actually checks — the page described
 * the storage, not the measurement.
 *
 * This section describes the measurement. The same fields, the same controls,
 * grouped under the six links of the user-value chain: connection, discovery,
 * selection, tool call, response, user value. Each group names the question it
 * answers, lists what will grade it, and says plainly when nothing will.
 *
 * WHAT IT IS NOT. It shows no results. A chain is one trial's journey and a
 * funnel is a population statistic; this is neither. Every chip here says what
 * a grader IS (a gate, or advisory), never what a run DID, and the empty-state
 * copy deliberately avoids the run-state word "not measured" —
 * `STAGE_EMPTY_COPY` carries the two config-state answers instead.
 *
 * The controls are the SAME controls the old rows used, wired to the same
 * draft dispatches. Nothing about what a save writes changes here; only where
 * a reader finds it does.
 */

import { useMemo } from "react";
import {
  USER_VALUE_STAGES,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_QUESTIONS,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import { STAGE_CHIP_TONE_CLASS } from "@/components/evaluate/stage-chain-model";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { ModelDefinition } from "@/shared/types";
import { ValidatorsSection } from "./validators-section";
import { JudgesSection } from "./judges-section";
import { AddCheckMenu, blankPredicate, ChecksSection } from "./checks-section";
import { GlobalGatesSectionInfoHint } from "./global-gates-info";
import {
  groupGradersByStage,
  STAGE_EMPTY_COPY,
  type GraderRow,
} from "./suite-grading-model";
import type { EvalJudgeConfig } from "./types";

/**
 * The section's own hint, hoisted so the settings sheet and its tests name the
 * same sentence.
 */
export const PASS_OR_FAIL_HINT =
  "Gates decide the verdict. Advisory graders score alongside it and never change it. Cases and per-run overrides can relax a gate.";

/**
 * A grader's ROLE, as a chip.
 *
 * Two words and no colour drama: a gate is the ordinary case, and an advisory
 * grader is the exception worth marking. Neither is a warning — a suite whose
 * judge is advisory is not misconfigured, it is the default every suite starts
 * from — so the advisory chip takes the neutral tone rather than the amber one
 * that would send a reader off to fix something.
 */
function RoleChip({ role }: { role: GraderRow["role"] }) {
  return (
    <span
      className={`shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[10px] uppercase tracking-[0.06em] ${
        role === "gating" ? "text-foreground" : STAGE_CHIP_TONE_CLASS.unmeasured
      }`}
    >
      {role === "gating" ? "Gate" : "Advisory"}
    </span>
  );
}

function GraderRowLine({ row }: { row: GraderRow }) {
  return (
    <li className="flex items-start justify-between gap-3 text-xs text-foreground/90">
      <span className="min-w-0 break-words">{row.label}</span>
      <RoleChip role={row.role} />
    </li>
  );
}

/**
 * One stage: its name, the question it answers, and what grades it.
 *
 * The question comes from the contract's own vocabulary
 * (`USER_VALUE_STAGE_QUESTIONS`) rather than being written here, so the words a
 * reader sees on the settings page are the words they see on a run.
 */
function StageGroup({
  stage,
  rows,
  children,
}: {
  stage: UserValueStage;
  rows: GraderRow[];
  children?: React.ReactNode;
}) {
  return (
    <div className="py-3" data-stage-group={stage}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium text-foreground">
          {USER_VALUE_STAGE_LABELS[stage]}
        </h3>
        <p className="text-[11px] text-muted-foreground/60">
          {USER_VALUE_STAGE_QUESTIONS[stage]}
        </p>
      </div>
      {rows.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {rows.map((row) => (
            <GraderRowLine key={row.id} row={row} />
          ))}
        </ul>
      ) : (
        <p
          className={`mt-2 text-[11px] ${STAGE_CHIP_TONE_CLASS.unmeasured}`}
          data-stage-empty={stage}
        >
          {STAGE_EMPTY_COPY[stage]}
        </p>
      )}
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

export function SuitePassOrFailSection({
  matchOptions,
  onMatchOptionsChange,
  predicates,
  onPredicatesChange,
  judgeConfig,
  onJudgeConfigChange,
  availableModels,
  scenarioMigrationNotice,
  judgeAccessory,
  rubricEditor,
}: {
  matchOptions: EvalMatchOptions | undefined;
  onMatchOptionsChange: (next: EvalMatchOptions | undefined) => void;
  predicates: Predicate[];
  onPredicatesChange: (
    next: Predicate[] | ((previous: Predicate[]) => Predicate[]),
  ) => void;
  judgeConfig: EvalJudgeConfig | undefined;
  onJudgeConfigChange: (next: EvalJudgeConfig | undefined) => void;
  availableModels: ModelDefinition[];
  /** The "migrate scenario checks per case" warning, when the suite has any. */
  scenarioMigrationNotice?: React.ReactNode;
  /** S6 mounts the agreement line, the gate switch and its acknowledgement. */
  judgeAccessory?: React.ReactNode;
  /** S6 mounts the judge rubric editor under the user-value group. */
  rubricEditor?: React.ReactNode;
}) {
  const model = useMemo(
    () => groupGradersByStage({ matchOptions, predicates, judgeConfig }),
    [matchOptions, predicates, judgeConfig],
  );

  return (
    <div className="divide-y divide-border/40">
      {USER_VALUE_STAGES.map((stage) => (
        <StageGroup key={stage} stage={stage} rows={model.byStage[stage]}>
          {stage === "selection" ? (
            <div className="space-y-2" data-setting-key="matchOptions">
              <div className="text-[11px] font-medium text-foreground/80">
                Tool-call matching
              </div>
              <ValidatorsSection
                title=""
                value={matchOptions}
                inheritedFrom={MATCH_OPTIONS_DEFAULTS}
                onChange={onMatchOptionsChange}
              />
              {/* One control, two stages. `Arguments` grades whether the call
                  the model made was usable, which is the `call` link, so it is
                  listed there — said out loud here because the editor for it
                  lives under Selection and a reader would otherwise think the
                  page had misfiled it. */}
              <p className="text-[11px] text-muted-foreground/60">
                Arguments is edited here and measured at Tool call.
              </p>
            </div>
          ) : null}
          {stage === "userValue" ? (
            <div className="space-y-3" data-setting-key="judge">
              <div className="text-[11px] font-medium text-foreground/80">
                Judge
              </div>
              <p className="text-[11px] text-muted-foreground/60">
                Advisory by default. A calibrated judge may gate; see Judge
                criteria.
              </p>
              <JudgesSection
                chrome="bare"
                value={judgeConfig}
                availableModels={availableModels}
                onChange={onJudgeConfigChange}
              />
              {judgeAccessory}
              {rubricEditor ? (
                <div className="space-y-1.5" data-setting-key="judgeRubric">
                  <div className="text-[11px] font-medium text-foreground/80">
                    Judge criteria
                  </div>
                  <p className="text-[11px] text-muted-foreground/60">
                    Applied to every case, alongside each case&apos;s own
                    expected output. The judge cites criterion ids in its
                    reasons.
                  </p>
                  {rubricEditor}
                </div>
              ) : null}
            </div>
          ) : null}
        </StageGroup>
      ))}

      {/* The ONE editor for every authored check.
          Deliberately not per-stage: an Add menu under each group would ask a
          person to know which stage their check files under before they can
          write it, and that routing is the page's job rather than theirs. */}
      <div className="py-3" data-setting-key="checks">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-1">
            <h3 className="text-xs font-medium text-foreground">Checks</h3>
            <GlobalGatesSectionInfoHint />
          </div>
          <AddCheckMenu
            globalGatesMenu
            onAdd={(kind) =>
              onPredicatesChange((previous) => [
                ...previous,
                blankPredicate(kind),
              ])
            }
          />
        </div>
        {scenarioMigrationNotice ? (
          <div className="mt-2">{scenarioMigrationNotice}</div>
        ) : null}
        <div className="mt-3">
          <ChecksSection
            title=""
            hideAddButton
            hideEmptyState
            globalGatesMenu
            value={predicates}
            onChange={(next) => onPredicatesChange(next)}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Budgets, as their own row.
 *
 * A token ceiling and a turn ceiling both file at `userValue` analytically —
 * `GRADER_PRESENTATION_GROUP` says so and nothing derives a verdict from this
 * grouping — but reading them beside "did the answer contain the right thing"
 * makes neither legible. So they are lifted out of the stage list and shown
 * here.
 *
 * READ-ONLY on purpose. They are ordinary checks, edited in the one Checks
 * editor above with everything else; a second editor for the same two kinds
 * would be a second place to look for a check someone remembers writing.
 */
export function SuiteBudgetsList({ predicates }: { predicates: Predicate[] }) {
  const budgets = useMemo(
    () => groupGradersByStage({ predicates }).budgets,
    [predicates],
  );
  if (budgets.length === 0) {
    return (
      <p className={`text-[11px] ${STAGE_CHIP_TONE_CLASS.unmeasured}`}>
        No ceilings. Add a token or turn budget from Checks.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {budgets.map((row) => (
        <GraderRowLine key={row.id} row={row} />
      ))}
    </ul>
  );
}
