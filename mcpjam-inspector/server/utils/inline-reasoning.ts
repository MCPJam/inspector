import type { LanguageModelV3 } from "@ai-sdk/provider";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";

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
