/**
 * Editing the effort on a saved {@link ModelSelection}.
 *
 * A selection belongs to one model: its source, connection and settings were
 * chosen for it. These helpers keep that invariant when the UI changes the
 * effort or swaps the model, and report what happened so the surface can say
 * so ("kept High" / "cleared: Model X doesn't support High").
 */
import type {
  ModelReasoningEffort,
  ModelSelection,
} from "@mcpjam/sdk/browser";
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import type { ModelDefinition } from "@/shared/types";
import {
  reasoningEffortOptions,
  reasoningEffortRouteForRow,
} from "@/lib/reasoning-effort-options";
import {
  modelSelectionFromDefinition,
  selectionBesideLegacyId,
} from "@/components/chat-v2/shared/model-selection";
import { modelTarget, sameModelTarget } from "@/lib/model-target";
import type { ModelSelectionPurpose } from "@mcpjam/sdk/browser";

export function selectionReasoningEffort(
  selection: ModelSelection | undefined | null,
): ModelReasoningEffort | undefined {
  return selection?.settings?.reasoningEffort;
}

/** The selection with its effort set (or cleared); other settings survive. */
export function withReasoningEffort(
  selection: ModelSelection,
  effort: ModelReasoningEffort | undefined,
): ModelSelection {
  const { settings, ...rest } = selection;
  const { reasoningEffort: _previous, ...otherSettings } = settings ?? {};
  const nextSettings = {
    ...otherSettings,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
  return Object.keys(nextSettings).length > 0
    ? { ...rest, settings: nextSettings }
    : rest;
}

export type EffortCarryResult = {
  /** Id to store beside the selection (the selection's own id when present). */
  modelId: string;
  selection: ModelSelection | undefined;
  /** Effort that survived the model change. */
  kept?: ModelReasoningEffort;
  /** Effort that could not follow the model (it was set on the old one). */
  dropped?: ModelReasoningEffort;
};

/**
 * Pick a new model for a saved config. The effort is kept only when the new
 * row lists it AND the row can be saved as a selection (an effort lives on the
 * selection); otherwise it is dropped and reported, never silently carried.
 * With no effort involved the legacy behaviour is unchanged: a selection is
 * stored only beside an unchanged row id.
 */
export function carryEffortToModel(args: {
  row: ModelDefinition;
  previousEffort: ModelReasoningEffort | undefined;
  purpose: ModelSelectionPurpose;
  /** The deployment stores selections; false ⇒ the legacy id alone. */
  selectionsSupported: boolean;
  harness?: Harness;
}): EffortCarryResult {
  const { row, previousEffort, purpose, selectionsSupported, harness } = args;
  const legacyId = String(row.id);
  if (!selectionsSupported) {
    return {
      modelId: legacyId,
      selection: undefined,
      ...(previousEffort ? { dropped: previousEffort } : {}),
    };
  }
  const supported = reasoningEffortOptions(
    row,
    reasoningEffortRouteForRow(row),
    harness,
  );
  if (previousEffort && supported.includes(previousEffort)) {
    // An effort needs a selection to live on, even for a bare-id row whose
    // selection cannot sit beside its legacy id: store the canonical id too.
    const selection = modelSelectionFromDefinition(row, undefined, purpose);
    if (selection) {
      return {
        modelId: selection.modelId,
        selection: withReasoningEffort(selection, previousEffort),
        kept: previousEffort,
      };
    }
  }
  return {
    modelId: legacyId,
    selection: selectionBesideLegacyId(row, purpose),
    ...(previousEffort ? { dropped: previousEffort } : {}),
  };
}

/**
 * Set the effort on the config's current selection.
 *
 * `bareIds`:
 *  - "canonicalize" (host Agent tab, case chips: they can read a stored
 *    canonical id back with `findModelForStoredChoice`): a bare-id BYOK row
 *    gets a selection built from its provenance, and the stored id becomes the
 *    selection's canonical id (`storedModelChoice`'s shape).
 *  - "keep-id" (surfaces keyed by the row's own id): only a selection that
 *    sits beside the unchanged id may carry an effort; a bare-id row yields
 *    `null` and the control is disabled there.
 *
 * `null` when the row cannot carry a selection at all.
 */
export function setEffortForRow(args: {
  row: ModelDefinition;
  selection: ModelSelection | undefined;
  effort: ModelReasoningEffort | undefined;
  purpose: ModelSelectionPurpose;
  bareIds?: "canonicalize" | "keep-id";
}): { modelId: string; selection: ModelSelection | undefined } | null {
  const { row, selection, effort, purpose, bareIds = "keep-id" } = args;
  const base =
    selection ??
    (bareIds === "canonicalize"
      ? modelSelectionFromDefinition(row, undefined, purpose)
      : selectionBesideLegacyId(row, purpose));
  if (!base) return null;
  // Clearing the effort on a selection we just synthesised for a bare-id row
  // goes back to the legacy shape, keeping the stored id stable.
  if (!selection && !effort) {
    return {
      modelId: String(row.id),
      selection: selectionBesideLegacyId(row, purpose),
    };
  }
  const next = withReasoningEffort(base, effort);
  return { modelId: next.modelId, selection: next };
}

/**
 * The saved environments a matrix cell (one client + one model target)
 * reuses: the client's environments with the same `comparisonKey` (see
 * `sameModelTarget`). Each effort of a model is its own cell, so Sonnet·High
 * and Sonnet·Low on one client reuse their own environment each; a pick whose
 * key no environment runs reuses none (a new one is derived). An environment
 * with no saved selection and a cell with none match on the bare id, as
 * before. `efforts` off (a deployment without saved selections) matches on
 * id alone.
 */
export function environmentsForModelCell<
  T extends { hostId: string; modelId?: string | null; modelSelection?: ModelSelection | null },
>(
  attached: readonly T[],
  cell: {
    hostId: string;
    modelId: string | undefined;
    picked: ModelSelection | undefined;
    efforts: boolean;
  },
): T[] {
  const sameCell = attached.filter(
    (environment) =>
      environment.hostId === cell.hostId &&
      (environment.modelId ?? undefined) === cell.modelId,
  );
  if (cell.modelId === undefined || !cell.efforts) return sameCell;
  const wanted = modelTarget(cell.modelId, cell.picked);
  return sameCell.filter((environment) =>
    sameModelTarget(
      modelTarget(cell.modelId!, environment.modelSelection),
      wanted,
    ),
  );
}
