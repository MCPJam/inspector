import {
  isLegacySelection,
  validateModelSelection,
  type ModelReasoningEffort,
  type RequestedModelSelection,
} from "@mcpjam/sdk/browser";
import type { ModelDefinition } from "@/shared/types";
import type { OrgVisibleConfig } from "@/components/chat-v2/shared/model-helpers";
import { compareSelectionForRow, resolveCompareSelectionRow } from "./compare-cards";
import { withReasoningEffort } from "./reasoning-effort-selection";

type ChatRequestSelection =
  | { kind: "picked"; selection: RequestedModelSelection }
  | { kind: "inherit" | "compatibility" }
  | { kind: "blocked"; reason: string };

/** Resolve request intent without replacing a saved connection or fallback. */
export function chatRequestSelection(args: {
  intent: "picked" | "inherit";
  selection?: RequestedModelSelection | null;
  model: ModelDefinition;
  orgConfig?: OrgVisibleConfig;
  allowLocal: boolean;
  /** Undefined preserves saved settings; null explicitly clears effort. */
  effort?: ModelReasoningEffort | null;
  temperature?: number;
  effortLevels?: readonly ModelReasoningEffort[];
}): ChatRequestSelection {
  if (args.intent === "inherit") return { kind: "inherit" };
  // Only the compatibility/new-pick boundary may derive from a row.
  const candidate = args.selection ?? compareSelectionForRow(args.model, args.orgConfig);
  const blocked = (reason: string): ChatRequestSelection => ({ kind: "blocked", reason });
  if (!candidate) return blocked("Choose an available model before sending.");
  let selection: RequestedModelSelection;
  if (isLegacySelection(candidate)) {
    selection = candidate;
  } else {
    const validated = validateModelSelection(candidate);
    if (!validated.ok) return blocked("The saved model choice is invalid. Choose a model again.");
    selection = validated.selection;
  }
  if (!args.allowLocal && (selection.source === "local" || selection.source === "legacy")) {
    return blocked("Choose a model available in this workspace before sending.");
  }
  const row = resolveCompareSelectionRow(selection, [args.model], args.orgConfig);
  const rowSelection = row && compareSelectionForRow(row, args.orgConfig);
  if (!row || row.disabled || (selection.source !== "legacy" &&
      selection.nativeModelId && rowSelection?.source !== "legacy" &&
      selection.nativeModelId !== (rowSelection?.nativeModelId ?? rowSelection?.modelId))) {
    return blocked("The saved model or connection is unavailable. Choose a model again.");
  }
  // Hosted synthesis is enabled after browser propagation is in place.
  if (!args.selection && selection.source === "hosted") return { kind: "compatibility" };
  const picked = selection.source !== "legacy" && args.effort !== undefined
      ? withReasoningEffort(selection, args.effort ?? undefined)
      : selection;
  if (picked.source === "legacy") return { kind: "picked", selection: picked };
  const effort = picked.settings?.reasoningEffort;
  if (effort && args.effortLevels && !args.effortLevels.includes(effort)) {
    return blocked("The saved reasoning effort is unavailable for this model. Choose a supported effort or another model.");
  }
  return { kind: "picked", selection: args.temperature !== undefined && !effort
    ? { ...picked, settings: { ...picked.settings, temperature: args.temperature } }
    : picked };
}
