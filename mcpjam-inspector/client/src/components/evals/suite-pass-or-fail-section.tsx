/**
 * "Scorers and judges", organized by the stage each grader measures.
 *
 * THE PROBLEM THIS SOLVES. The settings sheet used to list Tool calls, Default
 * checks and LLM as Judge as three unrelated rows, in the order the fields
 * happen to be stored. A person could read the whole page and still not know
 * which parts of their server the suite actually checks — the page described
 * the storage, not the measurement.
 *
 * This section describes the measurement. The same fields, the same controls,
 * now one table in user-value-chain order: connection, discovery, selection,
 * tool call, response, user value. Each group names the question it answers
 * and lists what will grade it.
 *
 * WHAT IT IS NOT. It shows no results. A chain is one trial's journey and a
 * funnel is a population statistic; this is neither. Every chip here says what
 * a grader IS (a gate, a warn, or a report), never what a run DID.
 */

import { useMemo } from "react";
import type { UserValueStage } from "@mcpjam/sdk/contract";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { ModelDefinition } from "@/shared/types";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { ChecksSection } from "./checks-section";
import {
  BUDGET_PREDICATE_KINDS,
  isBudgetPredicate,
  mergeBudgetPredicates,
} from "./suite-grading-model";
import { SuiteScorerTable } from "./suite-scorer-table";
import type { EvalJudgeConfig } from "./types";

/**
 * The section's own hint, hoisted so the settings sheet and its tests name the
 * same sentence.
 */
export const PASS_OR_FAIL_HINT =
  "Scorers evaluate the evidence available for each trial. Gate results contribute to the trial verdict; Warn highlights an advisory result; Report records it.";

export const JUDGE_HINT =
  "A judge scores trial evidence from 0–1. Goal completion can gate after review-protocol and calibration requirements are met, or through an explicit owner acknowledgement once protocol readiness is met.";

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
  stageFacts,
  capabilities,
  unavailableReason,
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
  /**
   * Read-only config facts per stage, for the stages the runner measures.
   *
   * A ReactNode rather than data: the facts need live host/server queries, and
   * this component is pure config-state rendering. The owner mounts them.
   */
  stageFacts?: Partial<Record<UserValueStage, React.ReactNode>>;
  capabilities?: SuiteCapabilities | null;
  unavailableReason?: string;
}) {
  return (
    <SuiteScorerTable
      matchOptions={matchOptions}
      onMatchOptionsChange={onMatchOptionsChange}
      predicates={predicates}
      onPredicatesChange={onPredicatesChange}
      judgeConfig={judgeConfig}
      onJudgeConfigChange={onJudgeConfigChange}
      availableModels={availableModels}
      scenarioMigrationNotice={scenarioMigrationNotice}
      judgeAccessory={judgeAccessory}
      rubricEditor={rubricEditor}
      stageFacts={stageFacts}
      capabilities={capabilities}
      unavailableReason={unavailableReason}
      passOrFailHint={PASS_OR_FAIL_HINT}
      judgeHint={JUDGE_HINT}
    />
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
