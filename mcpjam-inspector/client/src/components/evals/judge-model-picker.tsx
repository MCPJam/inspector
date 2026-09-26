/**
 * The judge-model picker shared by the suite judge settings
 * (`JudgesSection`) and a run's goal judge card (`GoalCompletionCard`).
 *
 * It is the one model picker (`ModelSelector`) in single-select mode with
 * `purpose: "judge"` rows ({@link judgeModelOptions}): MCPJam-hosted models the
 * catalog admits as judges, the managed default, and the current value when
 * it is not one of those, shown disabled and tagged so the saved choice is
 * visible without being offered again.
 */
import { useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ModelSelector } from "@/components/chat-v2/chat-input/model-selector";
import {
  JUDGE_INELIGIBLE_TAG,
  judgeModelOptions,
} from "@/components/chat-v2/shared/available-models";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { cn } from "@/lib/utils";
import type { ModelDefinition } from "@/shared/types";

export function JudgeModelPicker({
  id,
  value,
  availableModels,
  managedDefaultModelId,
  onChange,
  disabled = false,
  className,
  inModal = false,
}: {
  /** The trigger's id, for the caller's `<Label htmlFor>`. */
  id: string;
  /** The current judge model id. */
  value: string;
  availableModels: readonly ModelDefinition[];
  managedDefaultModelId: string;
  /** The picked row (never the current value's disabled row). */
  onChange: (model: ModelDefinition) => void;
  disabled?: boolean;
  className?: string;
  inModal?: boolean;
}) {
  const { models, currentIneligible } = useMemo(
    () =>
      judgeModelOptions(availableModels, {
        currentModelId: value,
        managedDefaultModelId,
      }),
    [availableModels, value, managedDefaultModelId],
  );
  const currentModel =
    models.find((model) => String(model.id) === value) ?? models[0]!;

  return (
    <ModelSelector
      inModal={inModal}
      currentModel={currentModel}
      availableModels={models}
      onModelChange={(model) => onChange(model)}
      disabled={disabled}
      analyticsLocation="eval_judge"
      rowTag={(model) =>
        currentIneligible && String(model.id) === value
          ? JUDGE_INELIGIBLE_TAG
          : undefined
      }
      trigger={
        <Button
          type="button"
          variant="outline"
          id={id}
          disabled={disabled}
          data-testid={`${id}-trigger`}
          className={cn(
            "h-8 justify-between gap-2 px-3 text-sm font-normal",
            className,
          )}
        >
          <span className="min-w-0 truncate">
            {compactModelLabel(currentModel.name) || value}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      }
    />
  );
}
