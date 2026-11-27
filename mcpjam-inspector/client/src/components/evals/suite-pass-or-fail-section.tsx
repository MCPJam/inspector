/**
 * Suite evaluator settings follow the stages a trial goes through, from
 * connection to user value. Each row shows a check and its role. The
 * scorecard shows the results after a run.
 *
 * CaseChecksPage uses the same SuiteScorerTable in case scope.
 */

import type { UserValueStage } from "@mcpjam/sdk/contract";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import type { Predicate } from "@mcpjam/sdk/predicates";
import type { ModelDefinition } from "@/shared/types";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import { SuiteScorerTable } from "./suite-scorer-table";
import type { GroundednessRunEvidence } from "./suite-judge-card";
import type { EvalJudgeConfig, EvalJudgeRubric } from "./types";

/**
 * The section's own hint, hoisted so the settings sheet and its tests name the
 * same sentence.
 */
export const PASS_OR_FAIL_HINT =
  "Evaluators grade the evidence available for each iteration.";

export const JUDGE_HINT =
  "A judge scores iteration evidence from 0–1. Set goal completion to Required to let it fail a run.";

export function SuitePassOrFailSection({
  matchOptions,
  onMatchOptionsChange,
  predicates,
  onPredicatesChange,
  judgeConfig,
  onJudgeConfigChange,
  availableModels,
  requireOrgKeys,
  onManageOrgProviders,
  onAddProvider,
  scenarioMigrationNotice,
  rubricEditor,
  stageFacts,
  capabilities,
  groundednessEvidence,
  judgeRubric,
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
  /** The organization requires its own provider keys for AI features. */
  requireOrgKeys?: boolean;
  /**
   * Opens the organization's AI providers, for a viewer who may manage them
   * while the organization requires its own keys (see `useAvailableModels`).
   */
  onManageOrgProviders?: () => void;
  /**
   * The same from a model search with no match, under any key policy, or
   * `null` when the organization offers this viewer none.
   */
  onAddProvider: (() => void) | null;
  /** The "migrate scenario assertions per case" warning, when the suite has any. */
  scenarioMigrationNotice?: React.ReactNode;
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
  groundednessEvidence?: GroundednessRunEvidence;
  /** The suite's rubric; the rubric-checks card lists its criteria. */
  judgeRubric?: EvalJudgeRubric;
}) {
  return (
    <SuiteScorerTable
      scope={{ kind: "suite", predicates, onPredicatesChange }}
      matchOptions={matchOptions}
      onMatchOptionsChange={onMatchOptionsChange}
      judgeConfig={judgeConfig}
      onJudgeConfigChange={onJudgeConfigChange}
      availableModels={availableModels}
      requireOrgKeys={requireOrgKeys}
      onManageOrgProviders={onManageOrgProviders}
      onAddProvider={onAddProvider}
      scenarioMigrationNotice={scenarioMigrationNotice}
      rubricEditor={rubricEditor}
      stageFacts={stageFacts}
      capabilities={capabilities}
      passOrFailHint={PASS_OR_FAIL_HINT}
      judgeHint={JUDGE_HINT}
      groundednessEvidence={groundednessEvidence}
      judgeRubric={judgeRubric}
    />
  );
}
