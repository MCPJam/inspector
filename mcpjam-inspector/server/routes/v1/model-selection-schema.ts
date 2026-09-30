/**
 * The public `ModelSelection` body, shared by every v1 write that saves one
 * (client `set.modelSelection`, environments, case `models[].selection`, suite
 * `executionConfig.modelSelection`).
 *
 * Validation is the SDK's own `validateModelSelection`, so the API, the SDK
 * and the backend agree on the shape. It answers with a NORMALIZED copy (fixed
 * key order, an empty `settings` collapsed) and reports every issue with its
 * dotted path, which is what the caller needs to fix a request. A secret can
 * never be carried: an unknown key is an `unknown_key` issue.
 *
 * `settings.reasoningEffort` is where an effort is saved. There is no other
 * saved carrier; `advancedConfig.reasoningEffort` is refused.
 */
import { z } from "zod";
import { validateModelSelection, type ModelSelection } from "@mcpjam/sdk";

export const modelSelectionSchema: z.ZodType<ModelSelection> = z
  .unknown()
  .transform((value, ctx) => {
    const result = validateModelSelection(value);
    if (result.ok) return result.selection;
    for (const issue of result.issues) {
      ctx.addIssue({
        code: "custom",
        path: issue.path === "" ? [] : issue.path.split("."),
        message: issue.message,
      });
    }
    return z.NEVER;
  }) as unknown as z.ZodType<ModelSelection>;

/** The 400 message for the retired `advancedConfig.reasoningEffort` claim. */
export const ADVANCED_CONFIG_REASONING_EFFORT_MESSAGE =
  "`advancedConfig.reasoningEffort` is not supported and was never applied. Save an effort on the model instead: `models[].selection.settings.reasoningEffort` (a full `selection` is required).";

/**
 * A model selection must be FOR the model it sits beside. Returns an error
 * message, or `undefined` when they agree (or either is absent).
 */
export function selectionModelMismatch(
  modelId: string | undefined,
  selection: ModelSelection | null | undefined,
): string | undefined {
  if (!selection || modelId === undefined) return undefined;
  return selection.modelId === modelId.trim()
    ? undefined
    : `selection.modelId "${selection.modelId}" must match model "${modelId.trim()}".`;
}
