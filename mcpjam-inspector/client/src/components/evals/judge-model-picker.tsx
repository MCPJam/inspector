/**
 * The judge-model picker shared by the suite judge settings
 * (`JudgesSection`) and a run's goal judge card (`GoalCompletionCard`).
 *
 * It is the one model picker (`ModelSelector`) in single-select mode with
 * `purpose: "judge"` rows ({@link judgeModelOptions}): MCPJam-hosted models the
 * catalog admits as judges and organization models from connections a judge
 * can run on, the managed default, and the current value when it is not one
 * of those, shown disabled and tagged so the saved choice is visible without
 * being offered again.
 *
 * While the organization requires its own keys, only organization models are
 * listed and there is no default: an unset judge reads "Choose a judge model",
 * and a saved judge the policy no longer allows shows only on the trigger, as
 * a warning.
 */
import { useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ProviderLogo } from "@/components/chat-v2/chat-input/model/provider-logo";
import {
  ModelSelector,
  OrgKeysDisallowedTriggerLabel,
} from "@/components/chat-v2/chat-input/model-selector";
import {
  isOrgKeysDisallowedRow,
  JUDGE_INELIGIBLE_TAG,
  judgeModelOptions,
} from "@/components/chat-v2/shared/available-models";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { modelRowKey } from "@/components/chat-v2/shared/model-selection";
import { cn } from "@/lib/utils";
import type { ModelDefinition } from "@/shared/types";
import type { ModelSelection } from "@mcpjam/sdk/browser";

/** The trigger of a judge picker with no judge chosen, under the policy. */
export const CHOOSE_JUDGE_MODEL = "Choose a judge model";

/** The same ask in full, as the unset trigger's tooltip. */
export const CHOOSE_ORG_JUDGE_MODEL =
  "Choose a judge model from an organization provider.";

/** Stands in for "no judge chosen" where the selector needs a model. */
const NO_JUDGE_MODEL: ModelDefinition = {
  id: "",
  name: CHOOSE_JUDGE_MODEL,
  provider: "custom",
  hosted: false,
};

export function JudgeModelPicker({
  id,
  value,
  selection,
  availableModels,
  managedDefaultModelId,
  onChange,
  disabled = false,
  className,
  inModal = false,
  requireOrgKeys = false,
  onManageOrgProviders,
  variant = "outline",
}: {
  /** The trigger's id, for the caller's `<Label htmlFor>`. */
  id: string;
  /** The current judge model id. */
  value: string;
  /**
   * The selection saved beside `value`. An organization judge is stored
   * under its canonical id, so its row is found through this.
   */
  selection?: ModelSelection | null;
  /** The organization requires its own provider keys for AI features. */
  requireOrgKeys?: boolean;
  /**
   * Opens the organization's AI providers. Passed only to a viewer who may
   * manage them; with no organization model to pick, the menu then offers
   * "Add a provider" instead of "Ask an organization admin".
   */
  onManageOrgProviders?: () => void;
  availableModels: readonly ModelDefinition[];
  managedDefaultModelId: string;
  /** The picked row (never the current value's disabled row). */
  onChange: (model: ModelDefinition) => void;
  disabled?: boolean;
  className?: string;
  inModal?: boolean;
  /** "pill" is the rounded chip with the provider logo, as in chat. */
  variant?: "outline" | "pill";
}) {
  const { models, currentIneligible, current } = useMemo(
    () =>
      judgeModelOptions(availableModels, {
        currentModelId: value,
        managedDefaultModelId,
        currentSelection: selection,
        requireOrgKeys,
      }),
    [availableModels, value, managedDefaultModelId, selection, requireOrgKeys],
  );
  // Under the policy nothing stands in for an unset judge: one must be chosen.
  const currentModel =
    current ??
    (requireOrgKeys
      ? NO_JUDGE_MODEL
      : (models.find((model) => String(model.id) === value) ?? models[0]!));

  return (
    <ModelSelector
      inModal={inModal}
      currentModel={currentModel}
      availableModels={models}
      onModelChange={(model) => onChange(model)}
      disabled={disabled}
      requireOrgKeys={requireOrgKeys}
      onManageOrgProviders={onManageOrgProviders}
      analyticsLocation="eval_judge"
      rowTag={(model) =>
        currentIneligible &&
        current &&
        modelRowKey(model) === modelRowKey(current)
          ? JUDGE_INELIGIBLE_TAG
          : undefined
      }
      trigger={
        <Button
          type="button"
          variant={variant === "pill" ? "secondary" : "outline"}
          id={id}
          disabled={disabled}
          data-testid={`${id}-trigger`}
          className={cn(
            "h-8 justify-between gap-2 px-3 text-sm font-normal",
            variant === "pill" && "rounded-full",
            className,
          )}
        >
          {variant === "pill" && !isOrgKeysDisallowedRow(currentModel) && currentModel !== NO_JUDGE_MODEL ? (
            <ProviderLogo
              provider={currentModel.provider}
              customProviderName={currentModel.customProviderName}
            />
          ) : null}
          {isOrgKeysDisallowedRow(currentModel) ? (
            <OrgKeysDisallowedTriggerLabel model={currentModel} />
          ) : currentModel === NO_JUDGE_MODEL ? (
            <span
              className="min-w-0 truncate text-muted-foreground"
              title={CHOOSE_ORG_JUDGE_MODEL}
            >
              {CHOOSE_JUDGE_MODEL}
            </span>
          ) : (
            <span className="min-w-0 truncate">
              {compactModelLabel(currentModel.name) || value}
            </span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      }
    />
  );
}
