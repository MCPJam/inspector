import type { RequestedModelSelection } from "@mcpjam/sdk";
import {
  isPlainRecord,
  readRoutingSelection,
  readSelectionOrigin,
} from "./model-resolution-local.js";

/** Read the server-owned choice and its paired conversion origin. */
export function readRuntimeModelChoice(
  config: Record<string, unknown> | null | undefined,
): {
  selection?: RequestedModelSelection;
  origin?: "backfill";
} {
  if (!config) return {};
  const label = config.modelSelectionLabel;
  if (label === undefined) {
    return {
      selection: readRoutingSelection(config.modelSelection),
      origin: readSelectionOrigin(config.modelSelectionOrigin),
    };
  }
  if (
    !isPlainRecord(label) ||
    Object.keys(label).some((key) => key !== "selection" && key !== "origin")
  ) {
    throw new Error("Invalid runtime modelSelectionLabel");
  }
  const selection = readRoutingSelection(label.selection);
  if (
    !selection ||
    (label.origin !== undefined && label.origin !== "backfill") ||
    (typeof config.modelId === "string" &&
      config.modelId !== selection.modelId &&
      (selection.source === "legacy" ||
        config.modelId !== selection.nativeModelId))
  ) {
    throw new Error("Runtime modelSelectionLabel does not match its model");
  }
  return { selection, origin: readSelectionOrigin(label.origin) };
}

/** An explicit choice replaces both inherited fields. */
export function inheritedSelectionOrigin(args: {
  selection?: RequestedModelSelection;
  requestSelection?: RequestedModelSelection;
  inheritedOrigin?: "backfill";
}): "backfill" | undefined {
  return args.selection && !args.requestSelection
    ? args.inheritedOrigin
    : undefined;
}
