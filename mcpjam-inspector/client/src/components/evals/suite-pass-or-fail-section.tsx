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

import type { UserValueStage } from "@mcpjam/sdk/contract";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { ModelDefinition } from "@/shared/types";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { SuiteScorerTable } from "./suite-scorer-table";
import type { GroundednessRunEvidence } from "./suite-judge-card";
import type { EvalJudgeConfig } from "./types";

/**
 * The section's own hint, hoisted so the settings sheet and its tests name the
 * same sentence.
 */
export const PASS_OR_FAIL_HINT =
  "Evaluators grade the evidence available for each iteration. Gate results contribute to the iteration verdict; Warn highlights an advisory result; Report records it.";

export const JUDGE_HINT =
  "A judge scores iteration evidence from 0–1. Goal completion can gate after review-protocol and calibration requirements are met, or through an explicit owner acknowledgement once protocol readiness is met.";

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
  groundednessEvidence,
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
  /** The "migrate scenario assertions per case" warning, when the suite has any. */
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
  groundednessEvidence?: GroundednessRunEvidence;
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
      groundednessEvidence={groundednessEvidence}
    />
  );
}
