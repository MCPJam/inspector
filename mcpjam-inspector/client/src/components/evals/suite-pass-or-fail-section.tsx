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
import { cn } from "@/lib/utils";
import {
  suiteSettingsChainSectionClass,
  SuiteSettingsChainNode,
} from "./suite-settings-section-chain";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { ModelDefinition } from "@/shared/types";
import { ValidatorsSection } from "./validators-section";
import { JudgesSection } from "./judges-section";
import { AddCheckMenu, blankPredicate, ChecksSection } from "./checks-section";
import { GlobalGatesSectionInfoHint } from "./global-gates-info";
import {
  BUDGET_PREDICATE_KINDS,
  groupGradersByStage,
  isBudgetPredicate,
  judgeMode,
  mergeBudgetPredicates,
  stageEmptyIsGap,
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

function judgeLineLabel(
  mode: ReturnType<typeof judgeMode>,
): string {
  switch (mode) {
    case "off":
      return "Judge off";
    case "manual":
      return "Judge on request";
    case "automatic":
      return "Judge, advisory";
    case "gating":
      return "Judge gates the verdict";
  }
}

function GraderRowLine({
  row,
  judge,
}: {
  row: GraderRow;
  judge?: ReturnType<typeof judgeMode>;
}) {
  return (
    <li className="flex items-start justify-between gap-3 text-xs text-foreground/90">
      <span className="min-w-0 break-words">{row.label}</span>
      {row.kind === "judge" && judge ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {judgeLineLabel(judge)}
        </span>
      ) : (
        <RoleChip role={row.role} />
      )}
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
  judge,
  facts,
  children,
}: {
  stage: UserValueStage;
  rows: GraderRow[];
  judge?: ReturnType<typeof judgeMode>;
  /** Read-only config facts, for a stage the runner measures. */
  facts?: React.ReactNode;
  children?: React.ReactNode;
}) {
  // A GAP is a stage somebody could grade and has not. Connection, discovery
  // and call have no grader to author at all, so an empty row list there is
  // the permanent, correct state rather than something wanting attention —
  // tinting them grouped the three stages that need nothing with the three
  // that are waiting on the reader. `stageEmptyIsGap` already draws that line.
  const isGap = rows.length === 0 && stageEmptyIsGap(stage);
  return (
    <section
      className={cn(suiteSettingsChainSectionClass())}
      data-stage-group={stage}
    >
      <SuiteSettingsChainNode />
      {/* The tint lives on an INNER wrapper: the section carries the chain's
          `pb-10` spacing between sections, and a background on that box draws
          the gap as 40px of empty tinted space below the content. */}
      <div className={cn(isGap && "rounded-lg bg-muted/60 px-4 py-4")}>
        <div className="mb-4 space-y-1">
          <h3 className="text-lg font-semibold tracking-tight text-foreground">
            {USER_VALUE_STAGE_LABELS[stage]}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {USER_VALUE_STAGE_QUESTIONS[stage]}
          </p>
        </div>
        {rows.length > 0 ? (
          <ul className="space-y-1">
            {rows.map((row) => (
              <GraderRowLine key={row.id} row={row} judge={judge} />
            ))}
          </ul>
        ) : (
          <div className="flex items-baseline gap-2">
            <p
              className={`text-sm ${STAGE_CHIP_TONE_CLASS.unmeasured}`}
              data-stage-empty={stage}
            >
              {STAGE_EMPTY_COPY[stage]}
            </p>
            {stage === "response" ? (
              <span className="text-sm text-foreground/80">Add a check</span>
            ) : null}
          </div>
        )}
        {facts}
        {children ? <div className="mt-5 space-y-3">{children}</div> : null}
      </div>
    </section>
  );
}

export type PassOrFailFocus =
  | { kind: "all" }
  | { kind: "stage"; stage: UserValueStage }
  | { kind: "checks" };

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
  focus,
  stageFacts,
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
  /** When set, only the matching slice of the pass-or-fail editor is shown. */
  focus?: PassOrFailFocus;
  /**
   * Read-only config facts per stage, for the stages the runner measures.
   *
   * A ReactNode rather than data: the facts need live host/server queries, and
   * this component is pure config-state rendering. The owner mounts them.
   */
  stageFacts?: Partial<Record<UserValueStage, React.ReactNode>>;
}) {
  const model = useMemo(
    () => groupGradersByStage({ matchOptions, predicates, judgeConfig }),
    [matchOptions, predicates, judgeConfig],
  );
  const judge = judgeMode(judgeConfig);
  const focusKind = focus?.kind ?? "all";
  const stagesToShow =
    focusKind === "stage" && focus?.kind === "stage"
      ? [focus.stage]
      : USER_VALUE_STAGES;
  const showStages = focusKind !== "checks";
  const showChecks = focusKind === "all" || focusKind === "checks";

  return (
    <div>
      {showStages
        ? stagesToShow.map((stage) => (
        <StageGroup
          key={stage}
          stage={stage}
          rows={model.byStage[stage]}
          judge={judge}
          facts={stageFacts?.[stage]}
        >
          {stage === "selection" ? (
            <div className="space-y-3" data-setting-key="matchOptions">
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  Tool-call matching
                </h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  Arguments is edited here and measured at Tool call.
                </p>
              </div>
              <ValidatorsSection
                title=""
                value={matchOptions}
                inheritedFrom={MATCH_OPTIONS_DEFAULTS}
                onChange={onMatchOptionsChange}
              />
            </div>
          ) : null}
          {stage === "userValue" ? (
            <div className="space-y-5" data-setting-key="judge">
              <div>
                <h4 className="text-sm font-semibold text-foreground">Judge</h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  Advisory by default. A calibrated judge may gate; see Judge
                  criteria.
                </p>
              </div>
              <JudgesSection
                chrome="bare"
                value={judgeConfig}
                availableModels={availableModels}
                onChange={onJudgeConfigChange}
              />
              {judgeAccessory}
              {rubricEditor ? (
                <div className="space-y-2" data-setting-key="judgeRubric">
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">
                      Judge criteria
                    </h4>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Applied to every case, alongside each case&apos;s own
                      expected output. The judge cites criterion ids in its
                      reasons.
                    </p>
                  </div>
                  {rubricEditor}
                </div>
              ) : null}
            </div>
          ) : null}
        </StageGroup>
      ))
        : null}

      {/* The ONE editor for every authored check.
          Deliberately not per-stage: an Add menu under each group would ask a
          person to know which stage their check files under before they can
          write it, and that routing is the page's job rather than theirs. */}
      {showChecks ? (
      <section
        className={suiteSettingsChainSectionClass()}
        data-setting-key="checks"
      >
        <SuiteSettingsChainNode />
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <h3 className="text-lg font-semibold tracking-tight text-foreground">
              Checks
            </h3>
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
          <div className="mb-4">{scenarioMigrationNotice}</div>
        ) : null}
        <ChecksSection
          title=""
          hideAddButton
          hideEmptyState
          globalGatesMenu
          value={predicates}
          onChange={(next) => onPredicatesChange(next)}
        />
      </section>
      ) : null}
    </div>
  );
}

/**
 * Budgets, as their own row — and as their own editor.
 *
 * A token ceiling and a turn ceiling both file at `userValue` analytically —
 * `GRADER_PRESENTATION_GROUP` says so and nothing derives a verdict from this
 * grouping — but reading them beside "did the answer contain the right thing"
 * makes neither legible. So they are lifted out of the stage list and shown
 * here.
 *
 * EDITABLE. This row used to be a read-only summary that told the reader to
 * go add a ceiling from Checks: the tab named a setting and then refused to
 * set it, and half its own instruction was false — the Checks menu offers a
 * token budget and has never offered a turn budget. It edits the SAME
 * `defaultPredicates` array the Checks editor does, filtered to the two
 * ceiling kinds, so a ceiling written here is the same check written there
 * and both lists show it.
 */
export function SuiteBudgetsSection({
  predicates,
  onPredicatesChange,
}: {
  predicates: Predicate[];
  onPredicatesChange: (
    next: Predicate[] | ((previous: Predicate[]) => Predicate[]),
  ) => void;
}) {
  const budgets = useMemo(
    () => predicates.filter(isBudgetPredicate),
    [predicates],
  );
  return (
    <ChecksSection
      title=""
      value={budgets}
      allowedKinds={BUDGET_PREDICATE_KINDS}
      emptyStateText="No ceilings — a trial may spend whatever it needs."
      onChange={(nextBudgets) =>
        // The updater form, not the resolved list: the reducer holds the
        // authoritative draft, and a check added to Checks in the same commit
        // would be lost by an array computed from this render's copy.
        onPredicatesChange((previous) =>
          mergeBudgetPredicates(previous, nextBudgets),
        )
      }
    />
  );
}
