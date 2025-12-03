/**
 * MCP Apps (SEP-1865) Detection Utilities
 *
 * This module provides helper functions for detecting and routing to the correct
 * UI renderer based on tool metadata and result content.
 *
 * Detection Priority:
 * 1. MCP Apps (SEP-1865): ui/resourceUri in tool metadata
 * 2. OpenAI Apps SDK: openai/outputTemplate in tool metadata
 * 3. MCP-UI: inline ui:// resource in tool result
 */

import { isUIResource } from "@mcp-ui/client";

export type UIType = "mcp-apps" | "openai-sdk" | "mcp-ui" | null;

/**
 * Detects which UI renderer to use based on tool metadata and result content.
 *
 * @param toolMeta - Tool metadata from tools/list
 * @param toolResult - Tool execution result
 * @returns UIType indicating which renderer to use
 */
export function detectUIType(
  toolMeta: Record<string, unknown> | undefined,
  toolResult: unknown,
): UIType {
  // 1. MCP Apps (SEP-1865): Check for ui/resourceUri metadata
  if (toolMeta?.["ui/resourceUri"]) {
    return "mcp-apps";
  }

  // 2. OpenAI SDK: Check for openai/outputTemplate metadata
  if (toolMeta?.["openai/outputTemplate"]) {
    return "openai-sdk";
  }

  // 3. MCP-UI: Check for inline ui:// resource in result
  const content = (toolResult as { content?: unknown[] })?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      // isUIResource is a type guard, cast to any for runtime type check
      if (isUIResource(item as any)) {
        return "mcp-ui";
      }
      // Also check nested resource
      if (
        item &&
        typeof item === "object" &&
        (item as { type?: string }).type === "resource" &&
        (item as { resource?: { uri?: string } }).resource?.uri?.startsWith(
          "ui://",
        )
      ) {
        return "mcp-ui";
      }
    }
  }

  return null;
}

/**
 * Extract the UI resource URI from tool metadata based on UI type.
 *
 * @param uiType - The detected UI type
 * @param toolMeta - Tool metadata
 * @returns Resource URI or null
 */
export function getUIResourceUri(
  uiType: UIType,
  toolMeta: Record<string, unknown> | undefined,
): string | null {
  switch (uiType) {
    case "mcp-apps":
      return (toolMeta?.["ui/resourceUri"] as string) ?? null;
    case "openai-sdk":
      return (toolMeta?.["openai/outputTemplate"] as string) ?? null;
    default:
      return null;
  }
}

/**
 * Check if a tool has MCP Apps UI support
 *
 * @param toolMeta - Tool metadata
 * @returns true if tool has ui/resourceUri metadata
 */
export function isMCPAppsEnabled(
  toolMeta: Record<string, unknown> | undefined,
): boolean {
  return !!toolMeta?.["ui/resourceUri"];
}
