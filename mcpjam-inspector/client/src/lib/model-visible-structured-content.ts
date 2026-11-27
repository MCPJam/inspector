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

/** A rule from an untyped value, or undefined. */
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

/** The three parts of an MCP tool result, by their field names. */
export const TOOL_RESULT_PARTS = [
  "content",
  "structuredContent",
  "_meta",
] as const;
export type ToolResultPart = (typeof TOOL_RESULT_PARTS)[number];

/** The parts the model gets under a rule. */
export function toolResultPartsForRule(
  rule: ModelVisibleStructuredContent | undefined,
): ToolResultPart[] {
  switch (rule) {
    case "fallback":
      return ["content"];
    case "preferred":
      return ["structuredContent"];
    case "both":
      return ["content", "structuredContent"];
    default:
      return ["content", "structuredContent", "_meta"];
  }
}

/**
 * The rule after one part is toggled, given the parts now selected. Only four
 * of the seven combinations exist: `_meta` reaches the model only together
 * with the other two, in the default's one JSON string. So selecting `_meta`
 * selects all three, and deselecting `content` or `structuredContent` while
 * `_meta` is selected drops `_meta` too. Returns null when nothing would be
 * selected, which keeps the current rule.
 */
export function ruleForToolResultParts(
  current: ModelVisibleStructuredContent | undefined,
  selected: readonly string[],
): { rule: ModelVisibleStructuredContent | undefined } | null {
  const before = toolResultPartsForRule(current);
  const has = (part: ToolResultPart) => selected.includes(part);
  if (has("_meta") && !before.includes("_meta")) return { rule: undefined };
  const content = has("content");
  const structured = has("structuredContent");
  if (content && structured) {
    return { rule: has("_meta") ? undefined : "both" };
  }
  if (content) return { rule: "fallback" };
  if (structured) return { rule: "preferred" };
  return null;
}
