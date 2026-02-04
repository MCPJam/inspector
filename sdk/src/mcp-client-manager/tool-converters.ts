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
  options?: ToolCallOptions;
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
 * Checks whether a tool is an MCP App by inspecting its _meta for a UI resource URI.
 *
 * @param toolMeta - The tool's _meta field from listTools result
 * @returns true if the tool is an MCP App
 */
export function isMcpAppTool(
  toolMeta: Record<string, unknown> | undefined
): boolean {
  if (!toolMeta) return false;
  // MCP Apps use _meta.ui.resourceUri (preferred) or legacy "ui/resourceUri".
  const nested = (toolMeta as { ui?: { resourceUri?: unknown } }).ui;
  if (typeof nested?.resourceUri === "string") return true;
  return typeof toolMeta["ui/resourceUri"] === "string";
}

/**
 * Checks whether a tool is a ChatGPT App by inspecting its _meta for an output template.
 *
 * @param toolMeta - The tool's _meta field from listTools result
 * @returns true if the tool is a ChatGPT App
 */
export function isChatGPTAppTool(
  toolMeta: Record<string, unknown> | undefined
): boolean {
  if (!toolMeta) return false;
  return typeof toolMeta["openai/outputTemplate"] === "string";
}

/**
 * Removes only the _meta field from a tool result (shallow copy).
 *
 * @param result - The full tool call result
 * @returns A shallow copy of the result without _meta
 */
export function scrubMetaFromToolResult(result: CallToolResult): CallToolResult {
  if (!result) return result;
  const copy = { ...result };
  if ((copy as Record<string, unknown>)._meta) {
    delete (copy as Record<string, unknown>)._meta;
  }
  return copy;
}

/**
 * Removes only structuredContent from a tool result (shallow copy).
 *
 * @param result - The full tool call result
 * @returns A shallow copy of the result without structuredContent
 */
export function scrubStructuredContentFromToolResult(
  result: CallToolResult
): CallToolResult {
  if (!result) return result;
  const copy = { ...result };
  if ((copy as Record<string, unknown>).structuredContent) {
    delete (copy as Record<string, unknown>).structuredContent;
  }
  return copy;
}

/**
 * Returns a shallow copy of a CallToolResult with _meta and structuredContent removed.
 *
 * @param result - The full tool call result
 * @returns A scrubbed shallow copy without _meta and structuredContent
 */
export function scrubMetaAndStructuredContentFromToolResult(
  result: CallToolResult
): CallToolResult {
  if (!result) return result;
  return scrubMetaFromToolResult(scrubStructuredContentFromToolResult(result));
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
    const toolMeta = toolDescription._meta as Record<string, unknown> | undefined;

    // Create the execute function that delegates to the provided callTool
    const execute = async (args: unknown, options?: ToolCallOptions) => {
      options?.abortSignal?.throwIfAborted();
      const result = await callTool({ name, args, options });
      return CallToolResultSchema.parse(result);
    };

    // For MCP app tools, strip _meta and structuredContent before sending to the LLM.
    // For ChatGPT app tools, strip structuredContent before sending to the LLM.
    // The raw execute() return value still reaches the UI stream unchanged.
    // Runtime signature: ({ toolCallId, input, output }) => ToolResultOutput
    // Note: Type assertion needed due to slight type misalignment between CallToolResult and JSONValue
    const toModelOutput = isMcpAppTool(toolMeta)
      ? ((opts: { toolCallId: string; input: unknown; output: unknown }) => {
          const scrubbed = scrubMetaAndStructuredContentFromToolResult(
            opts.output as CallToolResult
          );
          return { type: "json" as const, value: scrubbed as any } as any;
        })
      : isChatGPTAppTool(toolMeta)
        ? ((opts: { toolCallId: string; input: unknown; output: unknown }) => {
            const scrubbed = scrubStructuredContentFromToolResult(
              opts.output as CallToolResult
            );
            return { type: "json" as const, value: scrubbed as any } as any;
          })
        : undefined;

    let vercelTool: Tool;

    if (schemas === "automatic") {
      // Automatic mode: normalize the schema and create a dynamic tool
      const normalizedInputSchema = ensureJsonSchemaObject(inputSchema);
      vercelTool = dynamicTool({
        description,
        inputSchema: jsonSchema(normalizedInputSchema),
        execute,
        ...(toModelOutput ? { toModelOutput } : {}),
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
        ...(toModelOutput ? { toModelOutput } : {}),
      });
    }

    tools[name] = vercelTool;
  }

  return tools;
}
