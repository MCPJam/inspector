/**
 * The model's view of a tool result when the host sets
 * `modelVisibleMcpToolResults.structuredContent`: what the real client was
 * measured to show its model (Claude Desktop, Claude Code, Codex CLI; see the
 * prober's model-visibility probe). Every call site keeps its own projection
 * when the rule is unset, so hosts without a value are unchanged.
 */

import type { CallToolResult } from "@modelcontextprotocol/client";
import type {
  ModelVisibleMcpToolResults,
  ModelVisibleStructuredContent,
} from "../host-config/types.js";
import {
  mapMcpContentBlocksForModel,
  type McpLinkedResourceReader,
  type McpModelOutputContent,
  type McpModelOutputContentPart,
} from "./model-output.js";

export type McpModelOutputText = { type: "text"; value: string };

export type ToolResultRuleOptions = {
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  readResource?: McpLinkedResourceReader;
  abortSignal?: AbortSignal;
};

/** Sent when nothing in the result is visible, so no provider gets an empty tool result. */
export const EMPTY_TOOL_RESULT_TEXT = "[empty tool result]";

/** The host's rule, or undefined when the host keeps today's projection. */
export function structuredContentRuleOf(
  policy: ModelVisibleMcpToolResults | undefined
): ModelVisibleStructuredContent | undefined {
  const rule = policy?.structuredContent;
  return rule === "fallback" || rule === "preferred" || rule === "both"
    ? rule
    : undefined;
}

/**
 * Whether content counts as empty for `'fallback'`. Claude Desktop was
 * measured only with `content: []`; the prober's image-only, link-only and
 * resource-only runs say whether content holding just those blocks counts too.
 */
export function hasNoContentBlocks(result: CallToolResult): boolean {
  return !Array.isArray(result?.content) || result.content.length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A block as JSON without the `_meta` that clients keep out of model input. */
function withoutMeta(block: Record<string, unknown>): Record<string, unknown> {
  const { _meta: _blockMeta, ...rest } = block;
  if (rest.type === "resource" && isRecord(rest.resource)) {
    const { _meta: _resourceMeta, ...resource } = rest.resource;
    return { ...rest, resource };
  }
  return rest;
}

/**
 * Embedded text resources and resource links stay visible as compact JSON:
 * no client has been measured hiding them, and Codex sends a link this way.
 * Binary resources keep the image path's omission marker.
 */
function renderOtherBlock(
  block: Record<string, unknown>
): McpModelOutputContentPart | undefined {
  if (block.type === "resource_link") {
    return { type: "text", text: JSON.stringify(withoutMeta(block)) };
  }
  if (
    block.type === "resource" &&
    isRecord(block.resource) &&
    typeof block.resource.text === "string"
  ) {
    return { type: "text", text: JSON.stringify(withoutMeta(block)) };
  }
  return undefined;
}

/**
 * Projects a raw tool result (before any App scrub) under the host's rule.
 * An `isError` result takes the same shapes as a success: the evaluator grades
 * the raw result's `isError`, and an `error-text` output would be graded as a
 * protocol failure.
 */
export async function projectToolResultByRule(
  result: CallToolResult,
  rule: ModelVisibleStructuredContent,
  options: ToolResultRuleOptions = {}
): Promise<McpModelOutputText | McpModelOutputContent> {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  // The 2026-07-28 schema allows any JSON value; `null` counts as absent, as
  // in Codex's own handling.
  const structured = (result as { structuredContent?: unknown })
    ?.structuredContent;
  const structuredJson =
    structured === undefined || structured === null
      ? undefined
      : JSON.stringify(structured);

  const showBlocks = rule !== "preferred" || structuredJson === undefined;
  const showStructured =
    structuredJson !== undefined &&
    (rule !== "fallback" || hasNoContentBlocks(result));

  const parts = showBlocks
    ? await mapMcpContentBlocksForModel(blocks, options, renderOtherBlock)
    : [];
  if (showStructured && structuredJson !== undefined) {
    parts.push({ type: "text", text: structuredJson });
  }

  if (parts.length === 0) {
    return { type: "text", value: EMPTY_TOOL_RESULT_TEXT };
  }
  // Text alone goes out as `text`: OpenAI's chat provider JSON-encodes a
  // `content` array, which would bring back the escaped JSON this rule removes.
  if (parts.every((part) => part.type === "text")) {
    return {
      type: "text",
      value: parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n"),
    };
  }
  return { type: "content", value: parts };
}

/**
 * The policy without the client rule, for harness runs: the real CLI should
 * apply its own rule, and the strict harness profile schema refuses native
 * forwarding for a policy that carries one. A policy that held only the rule
 * becomes undefined, so fingerprints match a host without one.
 */
export function withoutStructuredContentRule<
  T extends ModelVisibleMcpToolResults,
>(policy: T | undefined): T | undefined {
  if (!policy || !("structuredContent" in policy)) return policy;
  const { structuredContent: _rule, ...rest } = policy;
  return Object.keys(rest).length > 0 ? (rest as T) : undefined;
}
