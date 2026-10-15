/**
 * Efforts in the Playground / Chat model menu (`ModelSelector`'s per-row
 * effort props), so a person picks a model and its effort in one place.
 *
 *  - single mode: a row's efforts pick that model at that effort (the effort
 *    is remembered for the model, like the composer chip).
 *  - compare mode (the v2 line-up): a row's efforts toggle that model ×
 *    effort pane in or out, so Sonnet·Low and Sonnet·High are two picks. A
 *    pane added beside a sibling of the same model starts from its
 *    transcript.
 *
 * Returns `undefined` (the menu picks models only) when efforts can't be
 * edited, or in compare mode before the v2 line-up exists.
 */
import { useMemo } from "react";
import { comparisonKey } from "@mcpjam/sdk/browser";
import type {
  ModelReasoningEffort,
  RequestedModelSelection,
} from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import type { ModelSelectorEffortProps } from "@/components/chat-v2/chat-input/model-selector";
import type { OrgVisibleConfig } from "@/components/chat-v2/shared/model-helpers";
import { modelRowKey } from "@/components/chat-v2/shared/model-selection";
import {
  compareEffortSelection,
  promoteCompareCard,
  removeCompareCard,
  resolveCompareSelectionRow,
  toggleCompareEffortCard,
  type CompareCard,
} from "@/lib/compare-cards";

export function useModelPickerEfforts({
  enabled,
  isMultiModelMode,
  selectedModel,
  reasoningEffort,
  levelsFor,
  onSingleModelChange,
  setReasoningEffortForModel,
  compareCards,
  compareSelections,
  availableModels,
  orgConfig,
  setCompareSelections,
  setSelectedModel,
  setSelectedModelIds,
  seedCard,
}: {
  enabled: boolean;
  isMultiModelMode: boolean;
  selectedModel: ModelDefinition | null | undefined;
  /** The single chat's effort for `selectedModel`. */
  reasoningEffort: ModelReasoningEffort | undefined;
  levelsFor: (model: ModelDefinition) => ModelReasoningEffort[];
  onSingleModelChange: (model: ModelDefinition) => void;
  setReasoningEffortForModel: (
    model: ModelDefinition,
    effort: ModelReasoningEffort | undefined,
  ) => void;
  compareCards: CompareCard[] | null;
  compareSelections: readonly RequestedModelSelection[] | null;
  availableModels: readonly ModelDefinition[];
  orgConfig: OrgVisibleConfig | undefined;
  setCompareSelections: (selections: RequestedModelSelection[]) => void;
  setSelectedModel: (
    model: ModelDefinition,
    options?: { userInitiated?: boolean },
  ) => void;
  setSelectedModelIds: (ids: string[]) => void;
  /** A new pane starts from `fromKey`'s transcript. */
  seedCard: (key: string, fromKey: string) => void;
}): ModelSelectorEffortProps | undefined {
  return useMemo(() => {
    if (!enabled) return undefined;

    if (!isMultiModelMode) {
      const selectedKey = selectedModel ? modelRowKey(selectedModel) : null;
      return {
        rowEfforts: (model) => {
          const levels = levelsFor(model);
          if (levels.length === 0) return undefined;
          return {
            levels,
            ...(modelRowKey(model) === selectedKey
              ? { current: reasoningEffort ?? null }
              : {}),
          };
        },
        onModelEffortSelect: (model, effort) => {
          onSingleModelChange(model);
          setReasoningEffortForModel(model, effort);
        },
      };
    }

    if (!compareCards || !compareSelections) return undefined;
    const cards = compareCards;
    const saved = compareSelections;
    // The line-up changed: keep the v1 id list and the lead model in step,
    // as the multi-model menu's own picks do.
    const apply = (selections: RequestedModelSelection[]) => {
      setCompareSelections(selections);
      const rows = selections
        .map((selection) =>
          resolveCompareSelectionRow(selection, availableModels, orgConfig),
        )
        .filter((row): row is ModelDefinition => !!row);
      setSelectedModelIds([...new Set(rows.map((row) => String(row.id)))]);
      const lead = rows[0];
      if (
        lead &&
        (!selectedModel || modelRowKey(lead) !== modelRowKey(selectedModel))
      ) {
        setSelectedModel(lead, { userInitiated: true });
      }
    };
    const keys = new Set(cards.map((card) => card.key));
    return {
      rowEfforts: (model) => {
        const levels = levelsFor(model);
        if (levels.length === 0) return undefined;
        if (!compareEffortSelection(model, orgConfig, undefined)) {
          return undefined;
        }
        return {
          levels,
          isPicked: (effort) => {
            const selection = compareEffortSelection(model, orgConfig, effort);
            return !!selection && keys.has(comparisonKey(selection));
          },
        };
      },
      onModelEffortSelect: (model, effort) => {
        const next = toggleCompareEffortCard(
          cards,
          saved,
          model,
          orgConfig,
          effort,
        );
        if (!next) return;
        if (next.added?.seedFrom) seedCard(next.added.key, next.added.seedFrom);
        apply(next.selections);
      },
      pickedEntries: cards.map((card) => ({
        key: card.key,
        model: card.model,
        label: card.label,
        ...(card.distinguishers.length > 0
          ? { detail: card.distinguishers.join(" · ") }
          : {}),
      })),
      onRemovePickedEntry: (key) => {
        const next = removeCompareCard(cards, saved, key);
        if (next) apply(next);
      },
      onPromotePickedEntry: (key) => {
        const next = promoteCompareCard(cards, saved, key);
        if (next) apply(next);
      },
    };
  }, [
    availableModels,
    compareCards,
    compareSelections,
    enabled,
    isMultiModelMode,
    levelsFor,
    onSingleModelChange,
    orgConfig,
    reasoningEffort,
    seedCard,
    selectedModel,
    setCompareSelections,
    setReasoningEffortForModel,
    setSelectedModel,
    setSelectedModelIds,
  ]);
}
