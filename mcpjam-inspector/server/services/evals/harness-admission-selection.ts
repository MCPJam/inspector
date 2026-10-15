/**
 * The saved model selection an eval harness case or host carries, as
 * admission reads it: only for the model it was saved for, and part of the
 * verdict's cache key.
 */
import type { ModelSelection } from "@mcpjam/sdk/browser";
import { readStoredModelSelection } from "../../utils/model-resolution-local.js";

/** The saved selection, only when it is for `modelId`. */
export function selectionForModel(
  value: unknown,
  modelId: string | undefined,
): ModelSelection | undefined {
  const selection = readStoredModelSelection(value);
  return selection && modelId && selection.modelId === modelId
    ? selection
    : undefined;
}

/** What a selection adds to a verdict cache key: its source and connection. */
export function selectionCacheKey(
  selection: ModelSelection | undefined,
): string {
  const connection =
    selection?.connectionRef?.kind === "orgProvider"
      ? selection.connectionRef.id
      : "";
  return `${selection?.source ?? ""}:${connection}`;
}
