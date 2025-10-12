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
} from "ai";
import type { FlexibleSchema } from "@ai-sdk/provider-utils";

const ensureJsonSchemaObject = (schema: unknown): JSONSchema7 => {
  if (schema && typeof schema === "object") {
    const record = schema as Record<string, unknown>;
    if (record.jsonSchema) {
      return ensureJsonSchemaObject(record.jsonSchema);
    }
    return record as JSONSchema7;
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

export async function convertMCPToolsToVercelTools<
  TOOL_SCHEMAS extends ToolSchemaOverrides | "automatic" = "automatic",
>(
  listToolsResult: ListToolsResult,
  {
    schemas = "automatic" as TOOL_SCHEMAS,
    callTool,
  }: ConvertOptions<TOOL_SCHEMAS>,
): Promise<ConvertedToolSet<TOOL_SCHEMAS>> {
  const tools: Record<string, Tool> = {};

  for (const toolDescription of listToolsResult.tools) {
    const { name, description, inputSchema } = toolDescription;

    const execute = async (
      args: unknown,
      options: ToolCallOptions,
    ): Promise<CallToolResult> => {
      options?.abortSignal?.throwIfAborted();
      const result = await callTool({ name, args, options });
      return CallToolResultSchema.parse(result);
    };

    let vercelTool: Tool;

    if (schemas === "automatic") {
      const normalizedInputSchema = ensureJsonSchemaObject(inputSchema);
      vercelTool = dynamicTool({
        description,
        inputSchema: jsonSchema({
          ...normalizedInputSchema,
          properties: (normalizedInputSchema.properties ?? {}) as Record<
            string,
            JSONSchema7Definition
          >,
          additionalProperties:
            normalizedInputSchema.additionalProperties ?? false,
        }),
        execute,
      });
    } else {
      const overrides = schemas as ToolSchemaOverrides;
      if (!(name in overrides)) {
        continue;
      }
      vercelTool = defineTool({
        description,
        inputSchema:
          overrides[name]?.inputSchema ??
          jsonSchema(ensureJsonSchemaObject(inputSchema)),
        execute,
      });
    }

    tools[name] = vercelTool;
  }

  return tools as ConvertedToolSet<TOOL_SCHEMAS>;
}
