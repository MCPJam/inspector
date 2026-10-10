/**
 * The saved model selection an eval harness case or host carries, as
 * admission reads it: whether the case runs on MCPJam's key or on an
 * organization connection's, and the picker stamp that choice implies.
 */
import {
  validateModelSelection,
  type ModelSelection,
} from "@mcpjam/sdk/browser";

/** A saved selection, validated, or undefined. Never trusts the shape. */
function validSelection(value: unknown): ModelSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const validated = validateModelSelection(value);
  return validated.ok ? validated.selection : undefined;
}

/** The saved selection, only when it is for `modelId`. */
export function selectionForModel(
  value: unknown,
  modelId: string | undefined,
): ModelSelection | undefined {
  const selection = validSelection(value);
  return selection && modelId && selection.modelId === modelId
    ? selection
    : undefined;
}

/**
 * The picker's own-provider stamp a case's selection implies, the same rule
 * `withSelectionRouting` applies to a live turn. Every non-hosted selection
 * is `hosted: false`; no selection leaves today's hosted-list check in charge.
 */
export function selectionHostedFlag(selection: ModelSelection | undefined): {
  hosted?: boolean;
} {
  if (!selection) return {};
  return selection.source === "hosted" ? {} : { hosted: false };
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
