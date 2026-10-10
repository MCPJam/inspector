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
 * the one checked is the one the id's targets were saved from, and picking
 * the other swaps them onto it. The value's targets are keyed by
 * `comparisonKey`, so two efforts of one model are two targets: one checked
 * row, whose chevron opens its efforts to the side (each level a checkbox).
 *
 * Cap awareness (D6): when `budget` is provided, an option that would
 * push the product over `maxTargets` is disabled with the product
 * explanation. A static `max=10` inside this pill is not sufficient.
 */
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import { useMemo } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  ModelSelector,
  type ModelSelectorExtraOption,
  type ModelSelectorRowEfforts,
} from "@/components/chat-v2/chat-input/model-selector";
import type { ModelWorkload } from "@/components/chat-v2/shared/available-models";
import { compactModelLabel } from "@/components/chat-v2/shared/model-helpers";
import {
  findModelForStoredChoice,
  modelRowKey,
  selectionBesideLegacyId,
} from "@/components/chat-v2/shared/model-selection";
import {
  modelTargetKey,
  syncExplicitTargets,
  targetProductCapReason,
  type ModelSelection,
  type ModelTarget,
  type TargetBudgetContext,
} from "@/components/environment-composer/environment-stack";
import { modelTarget } from "@/lib/model-target";
import { useAvailableModels } from "@/hooks/use-available-models";
import {
  reasoningEffortOptions,
  reasoningEffortRouteForRow,
} from "@/lib/reasoning-effort-options";
import { setEffortForRow } from "@/lib/reasoning-effort-selection";
import { modelTargetLabel } from "@/lib/environment-label";
import type { ModelReasoningEffort } from "@mcpjam/sdk/browser";
import {
  harnessModelLockReasonsByRow,
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
  const { availableModels, modelSelectionsSupported } = useAvailableModels({
    projectId,
  });
  // Per ROW, not per id: the hosted row and an org-connection row of one id
  // run on different keys, and a harness may run one and refuse the other.
  const harnessLockReasons = useMemo(
    () =>
      harnessModelLockReasonsByRow(
        availableModels,
        harnessTargets ?? [],
        purpose,
      ),
    [availableModels, harnessTargets, purpose],
  );

  const targets = value.explicitTargets;
  const explicit = useMemo(
    () => [...new Set(targets.map((target) => target.modelId))],
    [targets],
  );
  // The row each explicit target refers to: the one its selection was saved
  // from, else (a legacy pick) the hosted row with that id first.
  const pickedRows = useMemo(
    () =>
      targets.map((target) => ({
        id: target.modelId,
        key: modelTargetKey(target),
        target,
        row: findModelForStoredChoice(
          { modelId: target.modelId, selection: target.selection },
          availableModels,
          undefined,
        ),
      })),
    [targets, availableModels],
  );
  // Two efforts of one model resolve to one row: the selector lists it once.
  const selectedModels = useMemo(() => {
    const seen = new Set<string>();
    return pickedRows.flatMap(({ row }) => {
      if (!row || seen.has(modelRowKey(row))) return [];
      seen.add(modelRowKey(row));
      return [row];
    });
  }, [pickedRows]);
  const staleExplicit = [
    ...new Set(pickedRows.filter(({ row }) => !row).map(({ id }) => id)),
  ];
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

  // Every edit fills in the saved selection of a target that has none; the
  // row just picked decides the selection of its new target.
  const emit = (next: ModelSelection, picked?: ModelDefinition) =>
    onChange(
      syncExplicitTargets(next, {
        models: availableModels,
        ...(picked ? { picked } : {}),
      }),
    );

  const toggleDefaults = (checked: boolean) => {
    if (mode === "single") {
      emit({ includeClientDefaults: checked, explicitTargets: [] });
      return;
    }
    if (checked && replaceSoleChoice) {
      emit({ includeClientDefaults: true, explicitTargets: [] });
      return;
    }
    emit({ ...value, includeClientDefaults: checked });
  };

  const removeModelId = (modelId: string) =>
    emit({
      ...value,
      explicitTargets: targets.filter((target) => target.modelId !== modelId),
    });

  const addModel = (model: ModelDefinition) => {
    const modelId = String(model.id);
    const added: ModelTarget = { modelId };
    if (mode === "single") {
      emit({ includeClientDefaults: false, explicitTargets: [added] }, model);
      return;
    }
    if (explicit.includes(modelId)) {
      // Another row with this id was picked: this one takes its place. Every
      // target of the id moves onto the picked row's selection and keeps its
      // own settings, so Sonnet·Low + Sonnet·High stay two targets.
      const base = selectionBesideLegacyId(model, "evalTarget");
      const moved = targets
        .filter((target) => target.modelId === modelId)
        .map((target) => {
          const settings = target.selection?.settings;
          return modelTarget(
            modelId,
            base ? (settings ? { ...base, settings } : base) : undefined,
          );
        });
      emit(
        {
          ...value,
          explicitTargets: [
            ...targets.filter((target) => target.modelId !== modelId),
            ...(moved.length > 0 ? moved : [added]),
          ],
        },
        model,
      );
      return;
    }
    if (replaceSoleChoice) {
      emit({ includeClientDefaults: false, explicitTargets: [added] }, model);
      return;
    }
    emit({ ...value, explicitTargets: [...targets, added] }, model);
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
    harnessLockReasons.get(modelRowKey(model)) ?? rowCapReason(model, state);

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
            // "Sonnet · High" beside "Sonnet · Low": only what differs.
            ...targets.map((target) =>
              modelTargetLabel(target, targets, nameForId),
            ),
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
          includeDefaults || targets.length > 0
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

  // Efforts live in the menu: each model opens its efforts to the side. In
  // multiple mode a level toggles that model × effort target in or out, so
  // Sonnet·Low and Sonnet·High are two targets; in single mode it picks the
  // model at that effort. A bare-id BYOK row (no saveable selection) offers
  // none. A harness host offers only the levels its adapter applies (Claude
  // Code none yet); with several targets the first harness decides.
  const effortHarness = harnessTargets?.find(Boolean)?.harnessId as
    | Harness
    | undefined;
  const targetAt = (
    row: ModelDefinition,
    effort: ModelReasoningEffort | undefined,
  ): ModelTarget | null => {
    const write = setEffortForRow({
      row,
      selection: undefined,
      effort,
      purpose: "evalTarget",
    });
    return write ? modelTarget(write.modelId, write.selection) : null;
  };
  const targetKeys = new Set(targets.map((target) => modelTargetKey(target)));
  const rowEfforts = (
    row: ModelDefinition,
  ): ModelSelectorRowEfforts | undefined => {
    // Unknown (still loading) counts as supported, as the effort chip did.
    if (modelSelectionsSupported === false) return undefined;
    const levels = reasoningEffortOptions(
      row,
      reasoningEffortRouteForRow(row),
      effortHarness,
    );
    if (levels.length === 0 || !targetAt(row, levels[0])) return undefined;
    const picked = (effort: ModelReasoningEffort | undefined) => {
      const next = targetAt(row, effort);
      return !!next && targetKeys.has(modelTargetKey(next));
    };
    if (mode === "single") {
      const current = levels.find(picked) ?? (picked(undefined) ? null : undefined);
      return { levels, ...(current !== undefined ? { current } : {}) };
    }
    return {
      levels,
      isPicked: picked,
      // A new level adds a choice, like a new model does.
      canAdd: !wouldAddChoice || replaceSoleChoice,
    };
  };
  const pickModelEffort = (
    row: ModelDefinition,
    effort: ModelReasoningEffort | undefined,
  ) => {
    const next = targetAt(row, effort);
    if (!next) return;
    if (mode === "single" || replaceSoleChoice) {
      emit({ includeClientDefaults: false, explicitTargets: [next] }, row);
      return;
    }
    const key = modelTargetKey(next);
    if (targetKeys.has(key)) {
      emit({
        ...value,
        explicitTargets: targets.filter(
          (target) => modelTargetKey(target) !== key,
        ),
      });
      return;
    }
    if (wouldAddChoice) return;
    // Right after the model's other efforts, else at the end.
    let last = -1;
    targets.forEach((target, index) => {
      if (target.modelId === next.modelId) last = index;
    });
    const explicitTargets = [...targets];
    explicitTargets.splice(last >= 0 ? last + 1 : targets.length, 0, next);
    emit({ ...value, explicitTargets }, row);
  };

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
      rowEfforts={rowEfforts}
      onModelEffortSelect={pickModelEffort}
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
  const n = value.explicitTargets.length;
  const inheritedRaw = options?.clientDefaultLabel?.trim() ?? "";
  const inherited = inheritedRaw
    ? options?.modelName?.(inheritedRaw) || inheritedRaw
    : "";
  if (value.includeClientDefaults && n === 0) return inherited || "models";
  if (value.includeClientDefaults && n > 0) {
    return inherited ? `${inherited} +${n}` : `models +${n}`;
  }
  if (n === 1) {
    const id = value.explicitTargets[0]!.modelId;
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
