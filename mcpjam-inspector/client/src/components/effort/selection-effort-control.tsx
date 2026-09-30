/**
 * {@link EffortControl} bound to a saved model selection.
 *
 * Every saved-config surface (host Agent tab, environment / swarm composers,
 * judge pickers, eval matrices) has the same shape: a picker row, the config's
 * saved selection, and a write that stores the new selection beside the legacy
 * id. This component owns the capability lookup, the "why is it disabled"
 * copy, and the selection edit, so those surfaces only supply the write.
 *
 *  - options come from the row's route (`reasoningEffortOptions`); a row the
 *    catalog does not list, or an unresolved one, offers none ⇒ hidden (a
 *    saved effort is still shown, badged "no longer supported").
 *  - the effort lives on the selection. A bare-id BYOK row gets one built
 *    from its provenance (`storedModelChoice`'s shape); a row that cannot be
 *    expressed as a selection, or a deployment that stores none, shows the
 *    control disabled with the reason.
 */
import { useMemo } from "react";
import type {
  ModelSelection,
  ModelSelectionPurpose,
} from "@mcpjam/sdk/browser";
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import type { ModelDefinition } from "@/shared/types";
import {
  reasoningEffortOptions,
  reasoningEffortRouteForRow,
} from "@/lib/reasoning-effort-options";
import {
  selectionReasoningEffort,
  setEffortForRow,
} from "@/lib/reasoning-effort-selection";
import { EffortControl, type EffortControlProps } from "./effort-control";

export type SelectionEffortWrite = {
  modelId: string;
  selection: ModelSelection | undefined;
};

export type SelectionEffortControlProps = Pick<
  EffortControlProps,
  "variant" | "className" | "hint"
> & {
  /** The picker row the config's model resolves to; undefined = unresolved. */
  row: ModelDefinition | undefined;
  selection: ModelSelection | undefined;
  purpose: ModelSelectionPurpose;
  /** The deployment stores selections (else there is nowhere to put it). */
  selectionsSupported?: boolean;
  harness?: Harness;
  /**
   * How a bare-id BYOK row (`gpt-5`, Ollama) is handled; see
   * `setEffortForRow`. Default "keep-id": the control is disabled there with
   * a tooltip. Only surfaces that read a stored canonical id back
   * (`findModelForStoredChoice`) pass "canonicalize".
   */
  bareIds?: "canonicalize" | "keep-id";
  /** Externally imposed inert state (read-only page, harness gating). */
  disabled?: boolean;
  disabledReason?: string;
  onChange: (write: SelectionEffortWrite) => void;
};

export function SelectionEffortControl({
  row,
  selection,
  purpose,
  selectionsSupported = true,
  harness,
  bareIds = "keep-id",
  disabled = false,
  disabledReason,
  onChange,
  ...display
}: SelectionEffortControlProps) {
  const options = useMemo(
    () =>
      row
        ? reasoningEffortOptions(row, reasoningEffortRouteForRow(row), harness)
        : [],
    [row, harness],
  );
  const value = selectionReasoningEffort(selection);
  const canSave = useMemo(
    () =>
      !row ||
      setEffortForRow({ row, selection, effort: "high", purpose, bareIds }) !==
        null,
    [row, selection, purpose, bareIds],
  );

  let inertReason: string | undefined;
  if (disabled) inertReason = disabledReason;
  else if (!selectionsSupported && options.length > 0) {
    inertReason = "This deployment does not store model selections yet.";
  } else if (!canSave && options.length > 0) {
    inertReason =
      bareIds === "keep-id"
        ? "An effort can't be saved for a model on your own API key here. Set it on the client, or pick a hosted or organization model."
        : "This model's connection can't be saved with an effort. Pick it from a provider connection.";
  }
  const inert = disabled || inertReason !== undefined;

  return (
    <EffortControl
      {...display}
      options={options}
      value={value}
      disabled={inert}
      disabledReason={inertReason}
      onChange={(effort) => {
        if (!row) return;
        const write = setEffortForRow({
          row,
          selection,
          effort,
          purpose,
          bareIds,
        });
        if (write) onChange(write);
      }}
    />
  );
}
