/**
 * Playground / Chat compare cards, keyed by `comparisonKey`.
 *
 * A compare line-up is a list of saved selections (storage v2,
 * `selected-model-storage.ts`). Each selection is one card: two cards of one
 * model at Low and High are two cards, because their `comparisonKey`s differ.
 * Each card resolves to its OWN picker row (so an OpenRouter pick never lands
 * on the hosted row of the same id) and carries its OWN effort.
 *
 * Pure: no React, no storage.
 */
import {
  comparisonKey,
  isLegacySelection,
  selectionDistinguishers,
  type ModelReasoningEffort,
  type ModelSelection,
  type RequestedModelSelection,
} from "@mcpjam/sdk/browser";
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import type { ModelDefinition } from "@/shared/types";
import {
  isMCPJamProvidedModelMenuItem,
  type OrgVisibleConfig,
} from "@/components/chat-v2/shared/model-helpers";
import {
  findModelForStoredChoice,
  modelRowKey,
  modelSelectionFromDefinition,
} from "@/components/chat-v2/shared/model-selection";
import {
  reasoningEffortOptions,
  reasoningEffortRouteForRow,
} from "@/lib/reasoning-effort-options";
import { withReasoningEffort } from "@/lib/reasoning-effort-selection";
import { MAX_COMPARE_SELECTIONS } from "@/lib/selected-model-storage";

export { MAX_COMPARE_SELECTIONS };

export type CompareCard = {
  /** `comparisonKey(selection)`: the card's identity everywhere. */
  key: string;
  /** The picker row this card runs on. */
  model: ModelDefinition;
  /** What the line-up stores for this card. */
  selection: RequestedModelSelection;
  /**
   * The full selection an effort edit writes: the stored one, or, for a
   * stored legacy (own-key) entry, the row's own selection. `null` when the
   * row cannot be expressed as one — the card then offers no effort.
   */
  editableSelection: ModelSelection | null;
  /** The card's saved effort (may be one the row no longer offers). */
  reasoningEffort: ModelReasoningEffort | undefined;
  /** Levels this card's row supports; empty hides its chip. */
  reasoningEffortLevels: ModelReasoningEffort[];
  /** What tells this card apart from same-model siblings ("High"). */
  distinguishers: string[];
  /** Header title: model name plus distinguishers ("Sonnet 5 · High"). */
  label: string;
};

function isHostedRow(model: ModelDefinition): boolean {
  return isMCPJamProvidedModelMenuItem(model);
}

/**
 * The selection a picked row is stored as: its own selection, or — for an
 * own-key row with no canonical id (`grok-3`) — the legacy own-key form with
 * its provider. `null` only for a hosted row that cannot be expressed (never
 * stored as legacy: legacy means own key only).
 */
export function compareSelectionForRow(
  row: ModelDefinition,
  orgConfig: OrgVisibleConfig | undefined,
): RequestedModelSelection | null {
  const selection = modelSelectionFromDefinition(row, orgConfig, "chat");
  if (selection) return selection;
  if (isHostedRow(row)) return null;
  return {
    source: "legacy",
    modelId: String(row.id),
    provider: String(row.provider),
  };
}

/**
 * The row a stored selection runs on, or `undefined` when none is available.
 * A hosted selection only resolves to a hosted row and an own-key selection
 * (org, local, stored legacy) only to an own-key row: a card never silently
 * changes who pays.
 */
export function resolveCompareSelectionRow(
  selection: RequestedModelSelection,
  models: readonly ModelDefinition[],
  orgConfig: OrgVisibleConfig | undefined,
): ModelDefinition | undefined {
  if (isLegacySelection(selection)) {
    const own = models.filter(
      (model) => String(model.id) === selection.modelId && !isHostedRow(model),
    );
    return (
      (selection.provider
        ? own.find((model) => String(model.provider) === selection.provider)
        : undefined) ?? own[0]
    );
  }
  const row = findModelForStoredChoice(
    { modelId: selection.modelId, selection },
    models,
    orgConfig,
  );
  if (!row) return undefined;
  return (selection.source === "hosted") === isHostedRow(row) ? row : undefined;
}

/**
 * The cards of a stored line-up: each selection resolved to its row, in
 * order, skipping unavailable or disabled rows, at most
 * {@link MAX_COMPARE_SELECTIONS}. Labels show only what differs.
 */
export function resolveCompareCards(
  selections: readonly RequestedModelSelection[],
  models: readonly ModelDefinition[],
  orgConfig: OrgVisibleConfig | undefined,
  harness?: Harness,
): CompareCard[] {
  const resolved: {
    selection: RequestedModelSelection;
    model: ModelDefinition;
  }[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    const key = comparisonKey(selection);
    if (seen.has(key)) continue;
    const model = resolveCompareSelectionRow(selection, models, orgConfig);
    if (!model || model.disabled) continue;
    seen.add(key);
    resolved.push({ selection, model });
    if (resolved.length >= MAX_COMPARE_SELECTIONS) break;
  }
  const siblings = resolved.map((entry) => entry.selection);
  return resolved.map(({ selection, model }) => {
    const legacy = isLegacySelection(selection);
    const distinguishers = selectionDistinguishers(selection, siblings);
    return {
      key: comparisonKey(selection),
      model,
      selection,
      editableSelection: legacy
        ? modelSelectionFromDefinition(model, orgConfig, "chat")
        : selection,
      reasoningEffort: legacy ? undefined : selection.settings?.reasoningEffort,
      reasoningEffortLevels: reasoningEffortOptions(
        model,
        reasoningEffortRouteForRow(model),
        harness,
      ),
      distinguishers,
      label: [model.name, ...distinguishers].join(" · "),
    };
  });
}

/**
 * The line-up after the multi-model picker returned `rows`: every card of a
 * row that is still picked survives with its effort (so Sonnet·Low and
 * Sonnet·High both stay), in the picker's row order; a newly picked row
 * joins at its default; unpicked rows' cards go. Capped.
 */
export function mergePickedRows(
  cards: readonly CompareCard[],
  rows: readonly ModelDefinition[],
  orgConfig: OrgVisibleConfig | undefined,
  /**
   * The saved line-up. A saved card whose row has not loaded yet is not in
   * `cards` and not in the menu, so the user cannot have removed it: it is
   * kept (after the picked rows, within the cap) instead of being dropped.
   */
  saved: readonly RequestedModelSelection[] = [],
): RequestedModelSelection[] {
  const next: RequestedModelSelection[] = [];
  const seen = new Set<string>();
  const push = (selection: RequestedModelSelection) => {
    const key = comparisonKey(selection);
    if (seen.has(key) || next.length >= MAX_COMPARE_SELECTIONS) return;
    seen.add(key);
    next.push(selection);
  };
  for (const row of rows) {
    const rowKey = modelRowKey(row);
    const existing = cards.filter((card) => modelRowKey(card.model) === rowKey);
    if (existing.length > 0) {
      for (const card of existing) push(card.selection);
      continue;
    }
    const selection = compareSelectionForRow(row, orgConfig);
    if (selection) push(selection);
  }
  const resolved = new Set(cards.map((card) => comparisonKey(card.selection)));
  for (const selection of saved) {
    if (!resolved.has(comparisonKey(selection))) push(selection);
  }
  return next;
}

/**
 * The line-up with one card's effort changed. `null` when that would make
 * it identical to a sibling (same `comparisonKey`) or the card cannot carry
 * an effort.
 */
export function setCompareCardEffort(
  cards: readonly CompareCard[],
  cardKey: string,
  effort: ModelReasoningEffort | undefined,
): { selections: RequestedModelSelection[]; key: string } | null {
  const card = cards.find((entry) => entry.key === cardKey);
  if (!card?.editableSelection) return null;
  const updated = withReasoningEffort(card.editableSelection, effort);
  const key = comparisonKey(updated);
  if (key === cardKey) return null;
  if (cards.some((entry) => entry.key === key)) return null;
  return {
    selections: cards.map((entry) =>
      entry.key === cardKey ? updated : entry.selection,
    ),
    key,
  };
}

/**
 * The level "Compare another effort" adds for `card`: a supported level no
 * card of the same row already runs. Prefers the far end of the scale from
 * the card's own level: High when free (Default/Low → High), else the
 * highest free level; from the upper half, Low, else the lowest free level.
 * `null` when none is free or the card cannot carry an effort.
 */
export function nextCompareEffort(
  cards: readonly CompareCard[],
  card: CompareCard,
): ModelReasoningEffort | null {
  if (!card.editableSelection || card.reasoningEffortLevels.length === 0) {
    return null;
  }
  const rowKey = modelRowKey(card.model);
  const used = new Set(
    cards
      .filter((entry) => modelRowKey(entry.model) === rowKey)
      .map((entry) => entry.reasoningEffort),
  );
  const levels = card.reasoningEffortLevels;
  const free = levels.filter((level) => !used.has(level));
  if (free.length === 0) return null;
  const ownIndex = card.reasoningEffort
    ? levels.indexOf(card.reasoningEffort)
    : -1;
  const upperHalf = ownIndex >= 0 && ownIndex >= (levels.length - 1) / 2;
  // The familiar pair first (Low vs High), then the far end of the scale.
  const preferred: ModelReasoningEffort = upperHalf ? "low" : "high";
  if (free.includes(preferred)) return preferred;
  return upperHalf ? free[0]! : free[free.length - 1]!;
}

/**
 * The line-up with a card of the same model at another supported level,
 * inserted right after `cardKey`. `null` at the cap or when no level is free.
 */
export function addCompareEffortCard(
  cards: readonly CompareCard[],
  cardKey: string,
): { selections: RequestedModelSelection[]; key: string } | null {
  if (cards.length >= MAX_COMPARE_SELECTIONS) return null;
  const index = cards.findIndex((entry) => entry.key === cardKey);
  const card = cards[index];
  if (!card?.editableSelection) return null;
  const level = nextCompareEffort(cards, card);
  if (!level) return null;
  const added = withReasoningEffort(card.editableSelection, level);
  const key = comparisonKey(added);
  if (cards.some((entry) => entry.key === key)) return null;
  const selections = cards.map((entry) => entry.selection);
  selections.splice(index + 1, 0, added);
  return { selections, key };
}

/**
 * Put `lead` in the lead slot without changing the card count (host switch:
 * column count is a workspace preference, not a host property). An existing
 * card with the same key rotates to the front; otherwise slot 0 is replaced.
 */
export function replaceLeadCompareSelection(
  selections: readonly RequestedModelSelection[],
  lead: RequestedModelSelection,
): RequestedModelSelection[] {
  const key = comparisonKey(lead);
  if (selections.length === 0) return [lead];
  const index = selections.findIndex((entry) => comparisonKey(entry) === key);
  if (index === 0) return selections.slice();
  if (index > 0) {
    const rotated = selections.slice();
    rotated.splice(index, 1);
    return [lead, ...rotated];
  }
  return [lead, ...selections.slice(1)];
}
