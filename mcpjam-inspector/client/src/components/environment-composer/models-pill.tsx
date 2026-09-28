/**
 * Models slot of the environment composer — the second fan-out axis.
 *
 * The one model picker (`ModelSelector`) in multi-select mode, with the
 * composer's own choices around it:
 *  - `multiple` (evals, swarms): "Client defaults" first, then catalog models,
 *    each toggled on or off. Value is a {@link ModelSelection}.
 *  - `single`: picking a catalog model replaces the current explicit pick and
 *    closes — for future quick-switch surfaces.
 *
 * Rows are identified by `modelRowKey` (source, connection, id), so the same
 * id listed by the hosted catalog and under an org connection are two rows:
 * the one checked is the one whose saved selection is stored for that id, and
 * picking the other swaps the stored selection. The id list stays keyed by
 * the legacy id, so one id is one choice.
 *
 * Cap awareness (D6): when `budget` is provided, an option that would
 * push the product over `maxTargets` is disabled with the product
 * explanation. A static `max=10` inside this pill is not sufficient.
 */
import { useMemo } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  ModelSelector,
  type ModelSelectorExtraOption,
} from "@/components/chat-v2/chat-input/model-selector";
import type { ModelWorkload } from "@/components/chat-v2/shared/available-models";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import {
  findModelForStoredChoice,
  modelRowKey,
} from "@/components/chat-v2/shared/model-selection";
import {
  syncExplicitModelSelections,
  targetProductCapReason,
  type ModelSelection,
  type TargetBudgetContext,
} from "@/components/environment-composer/environment-stack";
import { useAvailableModels } from "@/hooks/use-available-models";
import {
  harnessModelLockReason,
  type HarnessModelTarget,
} from "@/lib/harness-model-locks";
import type { HarnessModelPurpose } from "@/shared/harness-model-support";
import { cn } from "@/lib/utils";
import type { ModelDefinition } from "@/shared/types";

/** Stands in for "no explicit pick" where the selector needs a model. */
const NO_EXPLICIT_MODEL: ModelDefinition = {
  id: "__client_defaults__",
  name: "Client defaults",
  provider: "unknown" as ModelDefinition["provider"],
  hosted: true,
};

export function ModelsPill({
  projectId,
  value,
  onChange,
  mode = "multiple",
  disabled,
  testId,
  inModal = false,
  budget,
  clientDefaultLabel,
  variant = "pill",
  workload = "evalTarget",
  harnessTargets,
  purpose = "eval",
}: {
  variant?: "pill" | "table";
  projectId: string;
  value: ModelSelection;
  onChange: (next: ModelSelection) => void;
  mode?: "single" | "multiple";
  disabled?: boolean;
  testId?: string;
  inModal?: boolean;
  /** Product-cap context from the composer. Absent ⇒ no product disable. */
  budget?: TargetBudgetContext;
  /** Secondary text on the Client-defaults row (the previewed host's model). */
  clientDefaultLabel?: string | null;
  /**
   * The harness each selected client runs (`null`/absent = emulated or not
   * known yet), with its runtime version when known (else the adapter's pinned
   * one). A model EVERY client's harness refuses for `purpose` renders
   * disabled with the reason; one only some refuse stays pickable and those
   * cells are skipped at resolve time.
   */
  harnessTargets?: ReadonlyArray<HarnessModelTarget | null | undefined>;
  /** Decides whether an unverified harness × model pair is pickable. */
  purpose?: HarnessModelPurpose;
  /**
   * What the picked models run as (capability locks, see
   * `MODEL_WORKLOAD_POLICIES`). Environment models are eval or swarm
   * targets; a surface picking a persona's model passes `persona`.
   */
  workload?: ModelWorkload;
}) {
  const { availableModels } = useAvailableModels({ projectId });
  const harnessLockReasons = useMemo(() => {
    const byId = new Map<string, string>();
    if (!harnessTargets || harnessTargets.length === 0) return byId;
    for (const model of availableModels) {
      const id = String(model.id);
      const reason = harnessModelLockReason(id, harnessTargets, purpose);
      if (reason) byId.set(id, reason);
    }
    return byId;
  }, [availableModels, harnessTargets, purpose]);

  const explicit = value.explicitModelIds;
  // The row each explicit id refers to: the one whose selection is saved for
  // it, else (a legacy pick) the hosted row with that id first.
  const pickedRows = useMemo(
    () =>
      explicit.map((id) => ({
        id,
        row: findModelForStoredChoice(
          { modelId: id, selection: value.explicitModelSelections?.[id] },
          availableModels,
          undefined,
        ),
      })),
    [explicit, value.explicitModelSelections, availableModels],
  );
  const selectedModels = useMemo(
    () => pickedRows.flatMap(({ row }) => (row ? [row] : [])),
    [pickedRows],
  );
  const staleExplicit = pickedRows
    .filter(({ row }) => !row)
    .map(({ id }) => id);
  const includeDefaults = value.includeClientDefaults;
  const nameForId = (id: string): string => {
    const row = pickedRows.find((picked) => picked.id === id)?.row;
    const listed =
      row ?? availableModels.find((model) => String(model.id) === id);
    return (
      (listed && compactModelLabel(listed.name)) || compactModelLabel(id) || id
    );
  };
  const triggerLabel = modelsPillTriggerLabel(value, {
    clientDefaultLabel,
    modelName: nameForId,
  });

  const replaceSoleChoice = canReplaceSoleChoice(budget);

  // Every edit keeps the saved selections in step with the picked ids; the
  // row just picked decides the selection saved for its id.
  const emit = (next: ModelSelection, picked?: ModelDefinition) =>
    onChange(
      syncExplicitModelSelections(next, {
        models: availableModels,
        previous: value,
        ...(picked ? { picked } : {}),
      }),
    );

  const toggleDefaults = (checked: boolean) => {
    if (mode === "single") {
      emit({ includeClientDefaults: checked, explicitModelIds: [] });
      return;
    }
    if (checked && replaceSoleChoice) {
      emit({ includeClientDefaults: true, explicitModelIds: [] });
      return;
    }
    emit({ ...value, includeClientDefaults: checked });
  };

  const removeModelId = (modelId: string) =>
    emit({
      ...value,
      explicitModelIds: explicit.filter((id) => id !== modelId),
    });

  const addModel = (model: ModelDefinition) => {
    const modelId = String(model.id);
    if (mode === "single") {
      emit(
        { includeClientDefaults: false, explicitModelIds: [modelId] },
        model,
      );
      return;
    }
    if (explicit.includes(modelId)) {
      // Another row with this id was picked: this one takes its place.
      emit(value, model);
      return;
    }
    if (replaceSoleChoice) {
      emit(
        { includeClientDefaults: false, explicitModelIds: [modelId] },
        model,
      );
      return;
    }
    emit({ ...value, explicitModelIds: [...explicit, modelId] }, model);
  };

  // The selector reports the whole next list; one row was added or removed.
  const handleSelectedModelsChange = (next: ModelDefinition[]) => {
    const before = new Set(selectedModels.map(modelRowKey));
    const added = next.find((model) => !before.has(modelRowKey(model)));
    if (added) {
      addModel(added);
      return;
    }
    const after = new Set(next.map(modelRowKey));
    const removed = selectedModels.find(
      (model) => !after.has(modelRowKey(model)),
    );
    if (removed) removeModelId(String(removed.id));
  };

  const wouldAddChoice = wouldExceedBudget(budget, { extraChoices: 1 });
  const defaultsCapBlocked =
    mode === "multiple" &&
    !includeDefaults &&
    wouldAddChoice &&
    !replaceSoleChoice;
  const capReason = budget
    ? targetProductCapReason(
        budget.hostCount,
        budget.choiceCount + 1,
        budget.maxTargets,
      )
    : undefined;
  const rowCapReason = (
    model: ModelDefinition,
    state: { selected: boolean },
  ): string | undefined =>
    mode === "multiple" &&
    !state.selected &&
    // Swapping in another row for a picked id adds no choice.
    !explicit.includes(String(model.id)) &&
    wouldAddChoice &&
    !replaceSoleChoice
      ? capReason
      : undefined;

  // A model every selected client's harness refuses is locked before any
  // budget reason. The selector only blocks adding a locked row, so a
  // persisted pick stays removable.
  const rowDisabledReason = (
    model: ModelDefinition,
    state: { selected: boolean },
  ): string | undefined =>
    harnessLockReasons.get(String(model.id)) ?? rowCapReason(model, state);

  const extraOptions: ModelSelectorExtraOption[] = [
    {
      id: "client-defaults",
      label: "Client defaults",
      ...(clientDefaultLabel ? { description: clientDefaultLabel } : {}),
      checked: includeDefaults,
      disabled: defaultsCapBlocked,
      ...(defaultsCapBlocked && capReason ? { disabledReason: capReason } : {}),
      onSelect: () => toggleDefaults(!includeDefaults),
      ...(testId ? { testId: `${testId}-client-defaults` } : {}),
    },
    // A picked id the catalog no longer lists stays removable.
    ...staleExplicit.map((id): ModelSelectorExtraOption => ({
      id: `stale:${id}`,
      label: id,
      description: "No longer in the catalog",
      checked: true,
      onSelect: () => removeModelId(id),
    })),
  ];

  const trigger =
    variant === "table" ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        data-testid={testId}
        aria-label="Models"
        className="h-auto min-h-8 w-full justify-start gap-2 px-2 text-left font-normal whitespace-normal"
      >
        <span className="min-w-0 flex-1 break-words">
          {[
            ...(includeDefaults
              ? [
                  clientDefaultLabel
                    ? compactModelLabel(clientDefaultLabel)
                    : "Client default",
                ]
              : []),
            ...explicit.map(nameForId),
          ].join(", ") || "Select models"}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </Button>
    ) : (
      <button
        type="button"
        disabled={disabled}
        data-testid={testId}
        aria-label="Models"
        className={cn(
          "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
          "outline-none transition-colors",
          includeDefaults || explicit.length > 0
            ? "border-border/60 bg-muted/40 hover:bg-muted/60"
            : "border-dashed border-border/60 bg-muted/30 hover:bg-muted/45",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {triggerLabel}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </button>
    );

  return (
    <ModelSelector
      trigger={trigger}
      inModal={inModal}
      disabled={disabled}
      analyticsLocation="environment_composer"
      workload={workload}
      currentModel={selectedModels[0] ?? NO_EXPLICIT_MODEL}
      availableModels={availableModels}
      onModelChange={addModel}
      multiModelEnabled={mode === "multiple"}
      selectedModels={selectedModels}
      onSelectedModelsChange={handleSelectedModelsChange}
      maxSelectedModels={Number.POSITIVE_INFINITY}
      allowEmptySelection
      extraOptions={extraOptions}
      rowDisabledReason={rowDisabledReason}
    />
  );
}

export function modelsPillTriggerLabel(
  value: ModelSelection,
  options?: {
    /** Inherited model id or display name when Client defaults is the only pick. */
    clientDefaultLabel?: string | null;
    /** Resolve a catalog id (or already-display string) to a compact label. */
    modelName?: (id: string) => string;
  },
): string {
  const n = value.explicitModelIds.length;
  const inheritedRaw = options?.clientDefaultLabel?.trim() ?? "";
  const inherited = inheritedRaw
    ? options?.modelName?.(inheritedRaw) || inheritedRaw
    : "";
  if (value.includeClientDefaults && n === 0) return inherited || "models";
  if (value.includeClientDefaults && n > 0) {
    return inherited ? `${inherited} +${n}` : `models +${n}`;
  }
  if (n === 1) {
    const id = value.explicitModelIds[0];
    return options?.modelName?.(id) || "1 model";
  }
  if (n > 1) return `${n} models`;
  return "No models · pick some";
}

function wouldExceedBudget(
  budget: TargetBudgetContext | undefined,
  delta: { extraChoices: number },
): boolean {
  if (!budget) return false;
  const nextChoices = budget.choiceCount + delta.extraChoices;
  return budget.hostCount * nextChoices > budget.maxTargets;
}

/**
 * At the product cap with exactly one current choice, adding any other
 * option is over budget — but replacing that sole choice stays within
 * the cap. The live composer commits each checkbox immediately, so
 * unchecking the current pick first yields zero choices and rolls back.
 * Offer the replacement as one commit instead of disabling every
 * alternative.
 */
function canReplaceSoleChoice(
  budget: TargetBudgetContext | undefined,
): boolean {
  if (!budget) return false;
  return (
    budget.choiceCount === 1 &&
    budget.hostCount <= budget.maxTargets &&
    budget.hostCount * 2 > budget.maxTargets
  );
}
