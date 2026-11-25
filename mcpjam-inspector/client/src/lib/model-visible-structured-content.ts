/**
 * Reads and writes `modelVisibleMcpToolResults.structuredContent`, the rule
 * for which half of a tool result (its text or its structured content) the
 * model sees. Unset keeps the projection every client had before the rule
 * existed: text, structured content and `_meta` in one JSON string.
 */

import type {
  ModelVisibleMcpToolResults,
  ModelVisibleStructuredContent,
} from "@mcpjam/sdk/host-config";

export const MODEL_VISIBLE_STRUCTURED_CONTENT_RULES = [
  "fallback",
  "preferred",
  "both",
] as const satisfies readonly ModelVisibleStructuredContent[];

/** A rule from an untyped value (a select's string), or undefined. */
export function parseModelVisibleStructuredContent(
  value: unknown,
): ModelVisibleStructuredContent | undefined {
  return value === "fallback" || value === "preferred" || value === "both"
    ? value
    : undefined;
}

/** The client's saved rule, or undefined when it keeps the default. */
export function getModelVisibleStructuredContent(
  policy: ModelVisibleMcpToolResults | undefined,
): ModelVisibleStructuredContent | undefined {
  return parseModelVisibleStructuredContent(policy?.structuredContent);
}

/**
 * The policy with the rule set, or with the key removed when `rule` is
 * undefined. A save replaces the whole policy, so every other key (the image
 * flags) is carried over. A policy left with no keys becomes undefined, the
 * same as a client that never set one.
 */
export function setModelVisibleStructuredContent(
  policy: ModelVisibleMcpToolResults | undefined,
  rule: ModelVisibleStructuredContent | undefined,
): ModelVisibleMcpToolResults | undefined {
  if (rule !== undefined) return { ...policy, structuredContent: rule };
  if (!policy) return undefined;
  const { structuredContent: _removed, ...rest } = policy;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
