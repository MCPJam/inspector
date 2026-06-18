/**
 * Tool conversion utilities for integrating MCP tools with Vercel AI SDK
 */

import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import {
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/client";
import {
  dynamicTool,
  jsonSchema,
  tool as defineTool,
  type Tool,
  type ToolCallOptions,
  type ToolSet,
} from "ai";
import { assertCallToolResult } from "./result-guards.js";

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
  /** When true, each tool requires user approval before execution */
  needsApproval?: boolean;
  /**
   * When true, include tools whose `_meta.ui.visibility` is `["app"]`
   * (SEP-1865 app-only tools) in the returned tool set. Defaults to `false`,
   * which is the spec-compliant behavior: app-only tools are hidden from the
   * model-facing tool set. Set to `true` only when intentionally mirroring a
   * host that does not implement SEP-1865 visibility filtering.
   */
  includeAppOnly?: boolean;
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

import { isAppOnlyTool } from "../host-config/app-only-tool.js";
export { isAppOnlyTool };

/**
 * Removes only the _meta field from a tool result (shallow copy).
 *
 * @param result - The full tool call result
 * @returns A shallow copy of the result without _meta
 */
export function scrubMetaFromToolResult(
  result: CallToolResult
): CallToolResult {
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
 * Renders a tool's MCP `outputSchema` into a compact, human-readable summary
 * that can be appended to the model-facing tool description.
 *
 * Provider tool definitions (Anthropic, OpenAI, …) only carry an input schema,
 * so a declared `outputSchema` never reaches the model. Without it the model
 * sees the raw structured result but has no idea what the individual fields
 * mean, and silently drops anything that isn't self-explanatory (e.g. a field
 * named `x` documented only in the output schema). Folding the output shape
 * into the description gives the model that context back.
 *
 * The summary intentionally covers only top-level properties — the common flat
 * structured-output case — to keep descriptions small; nested object fields are
 * listed by name/type so the model still knows they exist.
 *
 * @param outputSchema - The tool's `outputSchema` (MCP object schema) or undefined
 * @returns A summary string, or undefined when there is nothing useful to add
 */
export function describeOutputSchemaForModel(
  outputSchema: unknown
): string | undefined {
  if (!outputSchema || typeof outputSchema !== "object") return undefined;

  const schema = outputSchema as JSONSchema7;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return undefined;

  const required = new Set(
    Array.isArray(schema.required) ? schema.required : []
  );

  const lines: string[] = [];
  for (const [name, definition] of Object.entries(properties)) {
    if (definition === true || definition === false) {
      lines.push(`- ${name}`);
      continue;
    }

    const prop = definition as JSONSchema7;
    const type = Array.isArray(prop.type) ? prop.type.join(" | ") : prop.type;
    const meta = [type, required.has(name) ? "required" : undefined]
      .filter(Boolean)
      .join(", ");
    const head = meta ? `- ${name} (${meta})` : `- ${name}`;
    lines.push(prop.description ? `${head}: ${prop.description}` : head);
  }

  if (lines.length === 0) return undefined;

  return `Returns structured output with the following fields:\n${lines.join("\n")}`;
}

/**
 * Builds the model-facing description for a tool, appending a summary of its
 * `outputSchema` when present. Tools without an output schema are returned
 * unchanged.
 */
export function buildModelFacingDescription(
  description: string | undefined,
  outputSchema: unknown
): string | undefined {
  const outputSummary = describeOutputSchemaForModel(outputSchema);
  if (!outputSummary) return description;
  return description ? `${description}\n\n${outputSummary}` : outputSummary;
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
    needsApproval,
    includeAppOnly = false,
  }: ConvertOptions<ToolSchemaOverrides | "automatic">
): Promise<ToolSet> {
  const tools: ToolSet = {};

  for (const toolDescription of listToolsResult.tools) {
    const { name, description, inputSchema } = toolDescription;
    const toolMeta = toolDescription._meta as
      | Record<string, unknown>
      | undefined;

    // Provider tool definitions are input-only, so a declared outputSchema
    // never reaches the model. Fold it into the description so the model can
    // interpret the structured result it gets back.
    const modelDescription = buildModelFacingDescription(
      description,
      (toolDescription as { outputSchema?: unknown }).outputSchema
    );

    // SEP-1865: hosts that negotiate `io.modelcontextprotocol/ui` MUST NOT
    // include tools whose visibility omits `"model"` in the agent's tool list.
    if (!includeAppOnly && isAppOnlyTool(toolMeta)) {
      continue;
    }

    // Create the execute function that delegates to the provided callTool
    const execute = async (args: unknown, options?: ToolCallOptions) => {
      options?.abortSignal?.throwIfAborted();
      const result = await callTool({ name, args, options });
      return assertCallToolResult(result, `Tool "${name}" result`);
    };

    // For MCP app tools, strip _meta and structuredContent before sending to the LLM.
    // For ChatGPT app tools, strip structuredContent before sending to the LLM.
    // The raw execute() return value still reaches the UI stream unchanged.
    // Runtime signature: ({ toolCallId, input, output }) => ToolResultOutput
    // Note: Type assertion needed due to slight type misalignment between CallToolResult and JSONValue
    const toModelOutput = isMcpAppTool(toolMeta)
      ? (opts: { toolCallId: string; input: unknown; output: unknown }) => {
          const scrubbed = scrubMetaAndStructuredContentFromToolResult(
            opts.output as CallToolResult
          );
          return { type: "json" as const, value: scrubbed as any } as any;
        }
      : isChatGPTAppTool(toolMeta)
        ? (opts: { toolCallId: string; input: unknown; output: unknown }) => {
            const scrubbed = scrubStructuredContentFromToolResult(
              opts.output as CallToolResult
            );
            return { type: "json" as const, value: scrubbed as any } as any;
          }
        : undefined;

    let vercelTool: Tool;

    if (schemas === "automatic") {
      // Automatic mode: normalize the schema and create a dynamic tool
      const normalizedInputSchema = ensureJsonSchemaObject(inputSchema);
      vercelTool = dynamicTool({
        description: modelDescription,
        inputSchema: jsonSchema(normalizedInputSchema),
        execute,
        ...(toModelOutput ? { toModelOutput } : {}),
        ...(needsApproval != null ? { needsApproval } : {}),
      });
    } else {
      // Override mode: only include tools explicitly listed in overrides
      const overrides = schemas;
      if (!(name in overrides)) {
        continue;
      }
      vercelTool = defineTool<unknown, CallToolResult>({
        description: modelDescription,
        inputSchema: overrides[name].inputSchema,
        execute,
        ...(toModelOutput ? { toModelOutput } : {}),
        ...(needsApproval != null ? { needsApproval } : {}),
      });
    }

    tools[name] = vercelTool;
  }

  return tools;
}
