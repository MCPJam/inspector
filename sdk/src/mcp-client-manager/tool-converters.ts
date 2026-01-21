/**
 * Tool conversion utilities for integrating MCP tools with Vercel AI SDK
 */

import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import {
  CallToolResult,
  CallToolResultSchema,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  dynamicTool,
  jsonSchema,
  tool as defineTool,
  type Tool,
  type ToolCallOptions,
  type ToolSet,
} from "ai";

/**
 * Normalizes a schema to a valid JSON Schema object.
 * Many MCP tools omit the top-level type; Anthropic requires an object schema.
 *
 * @param schema - The input schema (may be incomplete)
 * @returns A normalized JSONSchema7 object
 */
export function ensureJsonSchemaObject(schema: unknown): JSONSchema7 {
  if (schema && typeof schema === "object") {
    const record = schema as Record<string, unknown>;
    const base: JSONSchema7 = record.jsonSchema
      ? ensureJsonSchemaObject(record.jsonSchema)
      : (record as JSONSchema7);

    // Many MCP tools omit the top-level type; Anthropic requires an object schema
    if (!("type" in base) || base.type === undefined) {
      base.type = "object";
    }

    if (base.type === "object") {
      base.properties = (base.properties ?? {}) as Record<
        string,
        JSONSchema7Definition
      >;
      if (base.additionalProperties === undefined) {
        base.additionalProperties = false;
      }
    }

    return base;
  }

  // Return a minimal valid object schema
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  } satisfies JSONSchema7;
}

/**
 * Function type for executing tool calls
 */
export type CallToolExecutor = (params: {
  name: string;
  args: unknown;
  options: ToolCallOptions;
}) => Promise<CallToolResult>;

/**
 * Input schema type for tool definitions
 */
type ToolInputSchema = Parameters<typeof dynamicTool>[0]["inputSchema"];

/**
 * Schema overrides for specific tools
 * Maps tool name to custom input schema definition
 */
export type ToolSchemaOverrides = Record<
  string,
  { inputSchema: ToolInputSchema }
>;

/**
 * Result type for converted tools
 * When explicit schemas are provided, returns typed object
 * When "automatic", returns generic record
 */
export type ConvertedToolSet<
  SCHEMAS extends ToolSchemaOverrides | "automatic",
> = SCHEMAS extends ToolSchemaOverrides
  ? { [K in keyof SCHEMAS]: Tool }
  : Record<string, Tool>;

/**
 * Options for tool conversion
 */
export interface ConvertOptions<
  TOOL_SCHEMAS extends ToolSchemaOverrides | "automatic",
> {
  /** Schema overrides or "automatic" for dynamic conversion */
  schemas?: TOOL_SCHEMAS;
  /** Function to execute tool calls */
  callTool: CallToolExecutor;
}

/**
 * Converts MCP tools to Vercel AI SDK format.
 *
 * @param listToolsResult - The result from listTools()
 * @param options - Conversion options including callTool executor
 * @returns A ToolSet compatible with Vercel AI SDK
 *
 * @example
 * ```typescript
 * const tools = await convertMCPToolsToVercelTools(listToolsResult, {
 *   callTool: async ({ name, args, options }) => {
 *     return await mcpClient.callTool({ name, arguments: args });
 *   },
 * });
 *
 * // Use with Vercel AI SDK
 * const result = await generateText({
 *   model: openai("gpt-4"),
 *   tools,
 *   messages: [{ role: "user", content: "..." }],
 * });
 * ```
 */
export async function convertMCPToolsToVercelTools(
  listToolsResult: ListToolsResult,
  {
    schemas = "automatic",
    callTool,
  }: ConvertOptions<ToolSchemaOverrides | "automatic">
): Promise<ToolSet> {
  const tools: ToolSet = {};

  for (const toolDescription of listToolsResult.tools) {
    const { name, description, inputSchema } = toolDescription;

    // Create the execute function that delegates to the provided callTool
    const execute = async (args: unknown, options: ToolCallOptions) => {
      options?.abortSignal?.throwIfAborted?.();
      const result = await callTool({ name, args, options });
      return CallToolResultSchema.parse(result);
    };

    let vercelTool: Tool;

    if (schemas === "automatic") {
      // Automatic mode: normalize the schema and create a dynamic tool
      const normalizedInputSchema = ensureJsonSchemaObject(inputSchema);
      vercelTool = dynamicTool({
        description,
        inputSchema: jsonSchema({
          type: "object",
          properties: normalizedInputSchema.properties ?? {},
          additionalProperties:
            normalizedInputSchema.additionalProperties ?? false,
        }),
        execute,
      });
    } else {
      // Override mode: only include tools explicitly listed in overrides
      const overrides = schemas;
      if (!(name in overrides)) {
        continue;
      }
      vercelTool = defineTool<unknown, CallToolResult>({
        description,
        inputSchema: overrides[name].inputSchema,
        execute,
      });
    }

    tools[name] = vercelTool;
  }

  return tools;
}
