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
import {
  validateModelSelection,
  type LegacyModelSelection,
  type ModelSelection,
  type RequestedModelSelection,
} from "@mcpjam/sdk";
import {
  readSelectionOrigin,
  readStoredLegacySelection,
} from "../../utils/model-resolution-local.js";

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

/**
 * A selection as a STORE-ONCE row may hold it: a full {@link ModelSelection},
 * or a STORED legacy one (`{ source: "legacy", modelId, provider? }`), which
 * means "own key only" — never MCPJam credits. Accepted on writes so a read
 * can be sent back verbatim; the platform validates the round trip. A legacy
 * selection is never written by a person choosing a model: sending a bare id
 * (the shorthand) is how a caller says "convert this for me".
 */
export const requestedModelSelectionSchema: z.ZodType<RequestedModelSelection> =
  z.unknown().transform((value, ctx) => {
    if (
      value !== null &&
      typeof value === "object" &&
      (value as { source?: unknown }).source === "legacy"
    ) {
      const legacy: LegacyModelSelection | undefined =
        readStoredLegacySelection(value);
      if (legacy) return legacy;
      ctx.addIssue({
        code: "custom",
        path: [],
        message:
          'a legacy selection is exactly { source: "legacy", modelId, provider? } with a non-empty modelId',
      });
      return z.NEVER;
    }
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
  }) as unknown as z.ZodType<RequestedModelSelection>;

/**
 * The model id a DTO reports beside a stored selection: COMPUTED from the
 * selection when there is one (store-once rows keep the selection as the only
 * copy), else the bare id an unlabelled row still carries.
 */
export function computedModelId(
  selection: unknown,
  bareModelId: unknown,
): string | undefined {
  const fromSelection =
    selection !== null &&
    typeof selection === "object" &&
    typeof (selection as { modelId?: unknown }).modelId === "string" &&
    (selection as { modelId: string }).modelId.trim() !== ""
      ? (selection as { modelId: string }).modelId
      : undefined;
  if (fromSelection) return fromSelection;
  return typeof bareModelId === "string" ? bareModelId : undefined;
}

/** The conversion marker a DTO echoes beside a selection, or `undefined`. */
export const selectionOriginField = readSelectionOrigin;

/** The 400 message for the retired `advancedConfig.reasoningEffort` claim. */
export const ADVANCED_CONFIG_REASONING_EFFORT_MESSAGE =
  "`advancedConfig.reasoningEffort` is not supported and was never applied. Save an effort on the model instead: `models[].selection.settings.reasoningEffort` (a full `selection` is required).";

/**
 * A model selection must be FOR the model it sits beside. Returns an error
 * message, or `undefined` when they agree (or either is absent).
 */
export function selectionModelMismatch(
  modelId: string | undefined,
  selection: RequestedModelSelection | null | undefined,
): string | undefined {
  if (!selection || modelId === undefined) return undefined;
  return selection.modelId === modelId.trim()
    ? undefined
    : `selection.modelId "${selection.modelId}" must match model "${modelId.trim()}".`;
}
