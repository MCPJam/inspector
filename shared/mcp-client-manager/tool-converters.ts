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
  ToolSet,
} from "ai";
import type { FlexibleSchema } from "@ai-sdk/provider-utils";

const ensureJsonSchemaObject = (schema: unknown): JSONSchema7 => {
  if (schema && typeof schema === "object") {
    const record = schema as Record<string, unknown>;
    const base: JSONSchema7 = record.jsonSchema
      ? ensureJsonSchemaObject(record.jsonSchema)
      : (record as JSONSchema7);

    // Many MCP tools omit the top-level type; Anthropic requires an object schema.
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

  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  } satisfies JSONSchema7;
};

type CallToolExecutor = (params: {
  name: string;
  args: unknown;
  options: ToolCallOptions;
}) => Promise<CallToolResult>;

export type ToolSchemaOverrides = Record<
  string,
  { inputSchema: FlexibleSchema<unknown> }
>;

export type ConvertedToolSet<
  SCHEMAS extends ToolSchemaOverrides | "automatic",
> = SCHEMAS extends ToolSchemaOverrides
  ? { [K in keyof SCHEMAS]: Tool }
  : Record<string, Tool>;

type ConvertOptions<TOOL_SCHEMAS extends ToolSchemaOverrides | "automatic"> = {
  schemas?: TOOL_SCHEMAS;
  callTool: CallToolExecutor;
};

export async function convertMCPToolsToVercelTools(
  listToolsResult: ListToolsResult,
  {
    schemas = "automatic",
    callTool,
  }: ConvertOptions<ToolSchemaOverrides | "automatic">,
): Promise<ToolSet> {
  const tools: ToolSet = {};

  for (const toolDescription of listToolsResult.tools) {
    const { name, description, inputSchema } = toolDescription;

    const execute = async (args: unknown, options: ToolCallOptions) => {
      options?.abortSignal?.throwIfAborted?.();
      const result = await callTool({ name, args, options });
      return CallToolResultSchema.parse(result);
    };

    let vercelTool: Tool;
    if (schemas === "automatic") {
      const normalizedInputSchema = ensureJsonSchemaObject(inputSchema);
      vercelTool = dynamicTool({
        description,
        inputSchema: jsonSchema({
          type: "object",
          properties: normalizedInputSchema.properties ?? {},
          additionalProperties:
            (normalizedInputSchema as any).additionalProperties ?? false,
        }),
        execute,
      });
    } else {
      const overrides = schemas;
      if (!(name in overrides)) {
        // If overrides are provided, only include tools explicitly listed
        continue;
      }
      vercelTool = defineTool({
        description,
        inputSchema: overrides[name].inputSchema,
        execute,
      });
    }

    tools[name] = vercelTool;
  }

  return tools;
}
