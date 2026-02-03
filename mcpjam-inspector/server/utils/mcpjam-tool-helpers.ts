/**
 * MCPJam Tool Helpers
 *
 * Utilities for serializing AI SDK tools to JSON Schema definitions
 * that can be sent to the Convex backend.
 */

import { z } from "zod";
import type { ToolSet } from "ai";

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const DEFAULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/**
 * Extract JSON Schema from an AI SDK tool's parameters or inputSchema.
 * Handles both Zod schemas (AI SDK tools) and raw JSON Schema (MCP tools).
 */
function extractJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema) {
    return DEFAULT_SCHEMA;
  }

  // MCP tools: already have jsonSchema property
  if (typeof schema === "object" && schema !== null && "jsonSchema" in schema) {
    return (schema as { jsonSchema: Record<string, unknown> }).jsonSchema;
  }

  // AI SDK tools: Zod schema that needs conversion
  try {
    return z.toJSONSchema(schema as z.ZodType) as Record<string, unknown>;
  } catch {
    return DEFAULT_SCHEMA;
  }
}

/**
 * Serialize AI SDK tools to JSON Schema definitions for Convex.
 * This flattens the tool definitions into a format the backend can use.
 */
export function serializeToolsForConvex(tools: ToolSet): ToolDefinition[] {
  const toolDefs: ToolDefinition[] = [];

  for (const [name, tool] of Object.entries(tools)) {
    if (!tool) continue;

    const toolAny = tool as Record<string, unknown>;
    const schema = toolAny.parameters ?? toolAny.inputSchema;

    toolDefs.push({
      name,
      description: toolAny.description as string | undefined,
      inputSchema: extractJsonSchema(schema),
    });
  }

  return toolDefs;
}
