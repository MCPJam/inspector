/**
 * The judge-model row on the Confirm step: the one judge setting a swarm
 * authors at creation.
 *
 * Before this the only place a goal's judge model could be chosen was the
 * post-create Grading popover on each goal, so a swarm always launched its
 * first run on the managed default. The pick is the same `judgeConfig` the
 * flow already sends with every goal it creates (and merges onto reused
 * ones); an untouched row sends nothing, so a goal's own judge is never
 * cleared by omission.
 */
import { Label } from "@mcpjam/design-system/label";
import {
  JUDGE_CREDITS_COST_NOTE,
  JUDGE_ORG_PROVIDER_COST_NOTE,
  JudgeModelControl,
} from "@/components/evals/judges-section";
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";
import { useAvailableModels } from "@/hooks/use-available-models";

const JUDGE_MODEL_ID = "new-swarm-judge-model";

export function NewSwarmJudgeRow({
  projectId,
  value,
  onChange,
}: {
  projectId?: string | null;
  value: GoalJudgeConfig | undefined;
  onChange: (next: GoalJudgeConfig | undefined) => void;
}) {
  const {
    availableModels,
    modelSelectionsSupported,
    requireOrgKeys,
    onManageOrgProviders,
  } = useAvailableModels({ projectId });
  return (
    <div
      className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/20 px-4 py-3"
      data-testid="new-swarm-judge-row"
    >
      <div className="min-w-0">
        <Label htmlFor={JUDGE_MODEL_ID} className="text-sm text-foreground">
          Judge model
        </Label>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Grades every session against its goal.{" "}
          {requireOrgKeys
            ? JUDGE_ORG_PROVIDER_COST_NOTE
            : JUDGE_CREDITS_COST_NOTE}
        </p>
      </div>
      <JudgeModelControl
        id={JUDGE_MODEL_ID}
        value={value}
        onChange={onChange}
        availableModels={availableModels}
        saveModelSelections={modelSelectionsSupported}
        requireOrgKeys={requireOrgKeys}
        onManageOrgProviders={onManageOrgProviders}
      />
    </div>
  );
}
