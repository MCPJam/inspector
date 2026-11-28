import { useMemo } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import type { ModelReasoningEffort, ModelSelection as SavedModelSelection } from "@mcpjam/sdk/browser";
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import { Button } from "@mcpjam/design-system/button";
import {
  ModelSelector,
  OrgKeysDisallowedTriggerLabel,
  type ModelSelectorRowEfforts,
} from "@/components/chat-v2/chat-input/model-selector";
import { ProviderLogo } from "@/components/chat-v2/chat-input/model/provider-logo";
import { isOrgKeysDisallowedRow } from "@/components/chat-v2/shared/available-models";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import { reasoningEffortLabel } from "@/components/effort/effort-control";
import {
  modelTargetKey,
  syncExplicitTargets,
  type ModelSelection,
  type ModelTarget,
} from "@/components/environment-composer/environment-stack";
import { useModelSelectionsSupported } from "@/hooks/use-project-environment-capability";
import type { HarnessModelTarget } from "@/lib/harness-model-locks";
import { modelTarget } from "@/lib/model-target";
import {
  evalModelRows,
  pickedModelTarget,
  resolveEvalModelChoice,
} from "@/lib/org-keys-model-target";
import {
  reasoningEffortOptions,
  reasoningEffortRouteForRow,
} from "@/lib/reasoning-effort-options";
import {
  selectionReasoningEffort,
  setEffortForRow,
} from "@/lib/reasoning-effort-selection";
import type { ModelDefinition } from "@/shared/types";

/**
 * The runtime whose reasoning-effort levels a model menu offers when its
 * models run on every client in `targets`, or `"mixed"` when those clients
 * disagree. Efforts differ per runtime (a Claude Code level is refused by
 * Codex), so a shared menu offers them only when every client takes the same
 * ones; `undefined` is an emulated client, which reads the provider's levels.
 */
export function sharedEffortHarness(
  targets: ReadonlyArray<HarnessModelTarget | null | undefined>,
): Harness | undefined | "mixed" {
  const ids = new Set(targets.map((target) => target?.harnessId));
  if (ids.size > 1) return "mixed";
  return [...ids][0] as Harness | undefined;
}

export function EvalModelChoices({
  inModal,
  value,
  onChange,
  disabled,
  testId,
  defaultModelId,
  availableModels: catalogModels,
  harnessTargets,
  effortEditable = true,
  requireOrgKeys = false,
  onManageOrgProviders,
  onAddProvider,
}: {
  /**
   * Offer each model's reasoning efforts in the model menus. Off where the
   * surface cannot persist a selection (the case run sheet writes model
   * strings).
   */
  effortEditable?: boolean;
  /**
   * The organization requires its own provider keys for AI features: a saved
   * model the list no longer offers shows on its trigger as not allowed.
   */
  requireOrgKeys?: boolean;
  /**
   * Opens the organization's AI providers, for a viewer who may manage them
   * while the organization requires its own keys (see `useAvailableModels`).
   */
  onManageOrgProviders?: () => void;
  /** The same, under any key policy, for a model search with no match; `null` when none is offered. */
  onAddProvider: (() => void) | null;
  inModal?: boolean;
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
  disabled: boolean;
  testId: string;
  defaultModelId?: string;
  availableModels: ModelDefinition[];
  /**
   * The client(s) the picked models run on (`null`/`undefined` = emulated or
   * not known yet). A model every one of them cannot run for an eval
   * (unsupported, or not verified on its runtime version) renders disabled
   * with the reason, the same verdict the server's eval admission reaches.
   * Required: a surface that has no client says so with `[]`.
   */
  harnessTargets: ReadonlyArray<HarnessModelTarget | null | undefined>;
}) {
  const availableModels = useMemo(
    () => evalModelRows(catalogModels, harnessTargets, requireOrgKeys),
    [catalogModels, harnessTargets, requireOrgKeys],
  );
  const harnessScope = useMemo(
    () => ({ targets: harnessTargets, purpose: "eval" as const }),
    [harnessTargets],
  );
  const effortHarness = sharedEffortHarness(harnessTargets);
  const selectionsSupported = useModelSelectionsSupported();
  // A saved selection names its source and connection. Under the policy only
  // that exact row is the target, so a hosted target never borrows an org row
  // that lists the same id. The warning names the model from the catalog,
  // since the menu would otherwise mark that org row as picked.
  const resolveModel = (
    id: string,
    saved = true,
    selection?: SavedModelSelection,
  ): ModelDefinition =>
    resolveEvalModelChoice(id, availableModels, requireOrgKeys, {
      saved,
      selection,
    });
  const targets = value.explicitTargets;
  const choices = [
    ...(value.includeClientDefaults
      ? [
          {
            key: "default",
            model: resolveModel(
              defaultModelId ?? "Client default",
              defaultModelId !== undefined,
            ),
            inherited: true,
            target: undefined as ModelTarget | undefined,
          },
        ]
      : []),
    ...targets.map((target) => ({
      key: modelTargetKey(target),
      model: resolveModel(target.modelId, true, target.selection),
      inherited: false,
      target: target as ModelTarget | undefined,
    })),
  ];
  const emit = (next: ModelSelection, picked?: ModelDefinition) =>
    onChange(
      syncExplicitTargets(next, {
        models: availableModels,
        ...(picked ? { picked } : {}),
      }),
    );
  // Replace (or, with no model, remove) one choice; the default row becomes
  // an explicit target when a model is picked on it.
  const changeChoice = (
    key: string,
    inherited: boolean,
    model?: ModelDefinition,
  ) => {
    const remaining = targets.filter(
      (target) => inherited || modelTargetKey(target) !== key,
    );
    emit(
      {
        includeClientDefaults: inherited ? false : value.includeClientDefaults,
        explicitTargets: model
          ? [...remaining, pickedModelTarget(model, requireOrgKeys)]
          : remaining,
      },
      model,
    );
  };
  // An effort a sibling target of the model already runs is not applied:
  // two targets never share a comparisonKey (the menu greys that level out).
  const replaceTarget = (key: string, next: ModelTarget) => {
    const nextKey = modelTargetKey(next);
    if (
      nextKey !== key &&
      targets.some((target) => modelTargetKey(target) === nextKey)
    )
      return;
    emit({
      ...value,
      explicitTargets: targets.map((target) =>
        modelTargetKey(target) === key ? next : target,
      ),
    });
  };
  const effortsOn =
    effortEditable && selectionsSupported && effortHarness !== "mixed";
  /**
   * The target a pick of `row` at `effort` saves (`base` is the selection it
   * keeps, when the pick stays on the same model), or null when an effort
   * can't be saved for this row here (a bare-id model on your own key).
   */
  const targetAt = (
    row: ModelDefinition,
    effort: ModelReasoningEffort | undefined,
    base?: SavedModelSelection,
  ): ModelTarget | null => {
    const write = setEffortForRow({
      row,
      selection: base,
      effort,
      purpose: "evalTarget",
    });
    return write ? modelTarget(write.modelId, write.selection) : null;
  };
  /**
   * The efforts a menu offers for `row`. `current` is the target the menu
   * edits (absent for "Add model" and the client's own model); its own key
   * never counts as taken, so its current level stays pickable.
   */
  const effortsFor =
    (current?: ModelTarget) =>
    (row: ModelDefinition): ModelSelectorRowEfforts | undefined => {
      if (!effortsOn) return undefined;
      const levels = reasoningEffortOptions(
        row,
        reasoningEffortRouteForRow(row),
        effortHarness,
      );
      if (levels.length === 0 || !targetAt(row, levels[0])) return undefined;
      const sameModel = current?.modelId === String(row.id);
      const base = sameModel ? current?.selection : undefined;
      const currentKey = current ? modelTargetKey(current) : undefined;
      const takenKeys = new Set(
        targets
          .map((target) => modelTargetKey(target))
          .filter((key) => key !== currentKey),
      );
      return {
        levels,
        ...(sameModel
          ? { current: selectionReasoningEffort(current?.selection) ?? null }
          : {}),
        isTaken: (effort) => {
          const next = targetAt(row, effort, base);
          return next !== null && takenKeys.has(modelTargetKey(next));
        },
      };
    };
  // A model "Add model" can still add: one with an effort left to pick, or
  // (no efforts) one that is not picked yet.
  const addable = (model: ModelDefinition) => {
    const efforts = effortsFor()(model);
    if (!efforts) {
      return !choices.some(
        (choice) =>
          !isOrgKeysDisallowedRow(choice.model) &&
          String(choice.model.id) === String(model.id),
      );
    }
    return [undefined, ...efforts.levels].some(
      (level) => !efforts.isTaken?.(level),
    );
  };
  return (
    <div data-testid={testId} className="space-y-1">
      {choices.map(({ key, model, inherited, target }) => {
        const effort = selectionReasoningEffort(target?.selection);
        return (
          <div key={key} className="flex min-w-0 items-start">
            <ModelSelector
              inModal={inModal}
              currentModel={model}
              availableModels={availableModels}
              disabled={disabled}
              requireOrgKeys={requireOrgKeys}
              onManageOrgProviders={onManageOrgProviders}
              onAddProvider={onAddProvider}
              harnessScope={harnessScope}
              analyticsLocation="eval_suite"
              workload="evalTarget"
              onModelChange={(next) => changeChoice(key, inherited, next)}
              rowEfforts={effortsFor(target)}
              onModelEffortSelect={(row, level) => {
                const next = targetAt(
                  row,
                  level,
                  target?.modelId === String(row.id)
                    ? target.selection
                    : undefined,
                );
                if (!next) return;
                // Only this target changes; a sibling effort stays. The
                // client's own model becomes an explicit pick, as a model
                // change there already does.
                if (inherited || !target) {
                  emit(
                    {
                      includeClientDefaults: false,
                      explicitTargets: [...targets, next],
                    },
                    row,
                  );
                } else {
                  replaceTarget(key, next);
                }
              }}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  className="h-auto min-h-8 min-w-0 flex-1 justify-start gap-2 px-2 text-left font-normal whitespace-normal"
                >
                  {isOrgKeysDisallowedRow(model) ? (
                    <>
                      <OrgKeysDisallowedTriggerLabel model={model} />
                      {/* Tells apart two targets of one model. */}
                      {effort ? (
                        <span className="shrink-0 text-muted-foreground">
                          {reasoningEffortLabel(effort)}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <ProviderLogo
                        provider={model.provider}
                        customProviderName={model.customProviderName}
                        className="size-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1 break-words">
                        {compactModelLabel(model.name)}
                        {effort ? (
                          <span className="text-muted-foreground">
                            {" "}
                            {reasoningEffortLabel(effort)}
                          </span>
                        ) : null}
                      </span>
                    </>
                  )}
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </Button>
              }
            />
            {choices.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${model.name} model`}
                title={`Remove ${model.name} model`}
                onClick={() => changeChoice(key, inherited)}
              >
                <X className="size-3.5" />
              </Button>
            ) : null}
          </div>
        );
      })}
      <ModelSelector
        inModal={inModal}
        currentModel={{
          id: "__add_model__",
          name: "Add model",
          provider: "unknown",
        }}
        availableModels={availableModels.filter(addable)}
        disabled={disabled}
        requireOrgKeys={requireOrgKeys}
        onManageOrgProviders={onManageOrgProviders}
        onAddProvider={onAddProvider}
        harnessScope={harnessScope}
        analyticsLocation="eval_suite"
        workload="evalTarget"
        onModelChange={(model) =>
          emit(
            {
              ...value,
              explicitTargets: [
                ...targets,
                pickedModelTarget(model, requireOrgKeys),
              ],
            },
            model,
          )
        }
        rowEfforts={effortsFor()}
        onModelEffortSelect={(row, level) => {
          const next = targetAt(row, level);
          if (next) {
            emit({ ...value, explicitTargets: [...targets, next] }, row);
          }
        }}
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            className="h-8 gap-2 px-2 text-xs font-normal text-muted-foreground"
          >
            <Plus className="size-3.5" />
            Add model
          </Button>
        }
      />
    </div>
  );
}
