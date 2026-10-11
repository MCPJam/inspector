/**
 * Flags that carry a saved model choice or its reasoning effort.
 *
 * `--effort` is the shorthand: it sets `settings.reasoningEffort` on the
 * selection the target ALREADY has, and the operation refuses it (naming
 * `modelSelection`) when there is none. `--model-selection` / `--compose-model-selection`
 * carry a whole selection as JSON, because a selection holds `source` and a
 * connection that only the caller knows.
 */
import { MODEL_REASONING_EFFORTS, type ModelReasoningEffort } from "@mcpjam/sdk";
import { parseJsonInputRecord } from "./json-input.js";
import { usageError } from "./output.js";

const EFFORT_LEVELS_NOTE = `(${MODEL_REASONING_EFFORTS.join(
  " | "
)}). Which levels a model accepts is \`supportedReasoningEfforts\` in \`mcpjam models list\`; one the route cannot apply is refused, never dropped.`;

/**
 * `--effort` on an update command: it only EDITS the effort on the selection
 * the target already has. To set a model and its effort together, send the
 * whole selection.
 */
export const EFFORT_FLAG_DESCRIPTION = `Set the reasoning effort ${EFFORT_LEVELS_NOTE} Only edits the effort on an existing model selection (refused when there is none); use --model-selection to set a model and effort together.`;

/** `--effort` on a request that carries its own effort (no saved selection). */
export const REQUEST_EFFORT_FLAG_DESCRIPTION = `Reasoning effort ${EFFORT_LEVELS_NOTE}`;

/** Parse one `--effort` value. */
export function parseEffortFlag(
  value: string,
  flag = "--effort"
): ModelReasoningEffort {
  const effort = value.trim().toLowerCase();
  if (!(MODEL_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw usageError(
      `${flag} expects one of ${MODEL_REASONING_EFFORTS.join(
        ", "
      )}, got "${value}".`
    );
  }
  return effort as ModelReasoningEffort;
}

/**
 * The shorthand's value from `--effort` / `--clear-effort` (`null` removes the
 * effort). The two say opposite things, so both is a usage error.
 */
export function effortShorthand(options: {
  effort?: string;
  clearEffort?: boolean;
}): ModelReasoningEffort | null | undefined {
  if (options.effort !== undefined && options.clearEffort) {
    throw usageError("Provide either --effort or --clear-effort, not both.");
  }
  if (options.clearEffort) return null;
  return options.effort !== undefined
    ? parseEffortFlag(options.effort)
    : undefined;
}

/** One `--model-selection` JSON object (inline, `@file`, or `-`). */
export function parseModelSelectionFlag(
  value: string,
  flag = "--model-selection"
): Record<string, unknown> {
  return parseJsonInputRecord(value, flag) as Record<string, unknown>;
}
