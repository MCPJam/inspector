import type { ModelDefinition } from "@/shared/types";
import {
  providerForModelId,
  runtimeChosenModelSentinelName,
} from "@/shared/model-provider";

export const RUNTIME_CHOSEN_MODEL_REASON =
  "This host's runtime chooses its own model on your own account.";

/**
 * The row for a runtime-chosen sentinel such as `cursor/auto` (Cursor Auto),
 * or undefined for an ordinary model id. Locked, because the account picks the
 * model: it shows what runs without offering a choice.
 */
export function runtimeChosenModelRow(
  modelId: string,
): ModelDefinition | undefined {
  const name = runtimeChosenModelSentinelName(modelId);
  if (!name) return undefined;
  return {
    id: modelId,
    name,
    provider: providerForModelId(modelId) ?? "ollama",
    disabled: true,
    disabledReason: RUNTIME_CHOSEN_MODEL_REASON,
  };
}
