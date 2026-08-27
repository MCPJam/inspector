import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  extractReasoningMiddleware,
  wrapLanguageModel,
  type LanguageModel,
} from "ai";

/**
 * Reasoning models that have no separate reasoning channel stream their scratch
 * work inside `<think>` tags on the text channel, so the chat renders it as the
 * answer. Moving it to `reasoning-*` parts is what lets `ReasoningPart` show it
 * as a reasoning block instead. BB-136.
 *
 * Safe to apply to every model: with no `<think>` tag in the text the
 * middleware passes the stream through untouched.
 */
export function withInlineReasoningExtracted(
  model: LanguageModelV3,
): LanguageModelV3 {
  return wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

/**
 * Same extraction for org-configured models, which come from the SDK factory
 * typed as the AI SDK `LanguageModel` union — that union also admits a bare
 * model-id string and the legacy v2 shape, and only a v3 model can carry
 * middleware. Narrowing on `specificationVersion` keeps the union honest
 * instead of casting it away. BB-136.
 */
export function withOrgInlineReasoningExtracted(
  model: LanguageModel,
): LanguageModel {
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    return model;
  }
  return withInlineReasoningExtracted(model);
}
