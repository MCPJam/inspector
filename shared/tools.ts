import { z, ZodTypeAny } from "zod";
import { zodToJsonSchema } from "@alcyone-labs/zod-to-json-schema";
import { tool, type Tool as VercelTool, type ToolCallOptions } from "ai";

type MastraToolExecuteArgs = {
  context?: unknown;
  runtimeContext?: unknown;
};

type MastraToolInstance = {
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  execute?: (
    args: MastraToolExecuteArgs,
    options?: ToolCallOptions,
  ) => Promise<unknown> | unknown;
};

const fallbackInputSchema = z.object({}).passthrough();

const UNREPRESENTABLE_JSON_SCHEMA_MESSAGES = [
  "Custom types cannot be represented in JSON Schema",
  "Function types cannot be represented in JSON Schema",
];

function isUnrepresentableSchemaError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    UNREPRESENTABLE_JSON_SCHEMA_MESSAGES.some((message) =>
      error.message.includes(message),
    )
  );
}

function isZodSchema(value: unknown): value is ZodTypeAny {
  return Boolean(
    value && typeof value === "object" && "safeParse" in (value as ZodTypeAny),
  );
}

function isDirectlyUnrepresentable(schema: ZodTypeAny): boolean {
  const schemaType = (schema as any)?._def?.type;
  return schemaType === "custom" || schemaType === "function";
}

function canConvertToJSONSchema(schema: ZodTypeAny): boolean {
  const toJSONSchema = (
    z as unknown as {
      toJSONSchema?: (
        schema: ZodTypeAny,
        options?: Record<string, unknown>,
      ) => unknown;
    }
  ).toJSONSchema;

  if (typeof toJSONSchema === "function") {
    try {
      toJSONSchema(schema);
      return true;
    } catch (error) {
      if (isUnrepresentableSchemaError(error)) {
        return false;
      }

      throw error;
    }
  }

  try {
    zodToJsonSchema(schema);
    return true;
  } catch (error) {
    if (isUnrepresentableSchemaError(error)) {
      return false;
    }

    throw error;
  }
}

function ensureInputSchema(schema: unknown): ZodTypeAny {
  if (!isZodSchema(schema)) {
    return fallbackInputSchema;
  }

  if (isDirectlyUnrepresentable(schema)) {
    return fallbackInputSchema;
  }

  if (!canConvertToJSONSchema(schema)) {
    return fallbackInputSchema;
  }

  return schema;
}

function ensureOutputSchema(schema: unknown): ZodTypeAny | undefined {
  if (!isZodSchema(schema)) {
    return undefined;
  }

  if (isDirectlyUnrepresentable(schema)) {
    return undefined;
  }

  if (!canConvertToJSONSchema(schema)) {
    return undefined;
  }

  return schema;
}

function extractPureToolName(toolKey: string): string {
  const separatorIndex = toolKey.indexOf("_");

  if (separatorIndex === -1 || separatorIndex === toolKey.length - 1) {
    return toolKey;
  }

  return toolKey.slice(separatorIndex + 1);
}

/**
 * Detect if a result is in MCP content format
 * MCP tools return results wrapped in a content array like:
 * { content: [{ type: "text", text: "..." }] }
 */
function isMCPContentFormat(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as any).content)
  );
}

/**
 * Extract the actual data from MCP content format
 * Handles JSON-encoded text content and returns the parsed data
 */
function extractMCPContent(result: any): unknown {
  if (!isMCPContentFormat(result)) {
    return result;
  }

  const content = result.content;
  if (content.length === 0) {
    return null;
  }

  // Handle text content with JSON
  if (content[0].type === "text" && typeof content[0].text === "string") {
    try {
      return JSON.parse(content[0].text);
    } catch {
      // If not valid JSON, return the text as-is
      return content[0].text;
    }
  }

  // Return raw content if not parseable
  return content;
}

export function convertMastraToolToVercelTool(
  toolName: string,
  mastraTool: MastraToolInstance,
  options?: { originalName?: string },
): VercelTool {
  const inputSchema = ensureInputSchema(mastraTool.inputSchema);
  const outputSchema = ensureOutputSchema(mastraTool.outputSchema);
  const displayName = options?.originalName ?? toolName;

  const vercelToolConfig: {
    type: "dynamic";
    description?: string;
    inputSchema: ZodTypeAny;
    outputSchema?: ZodTypeAny;
    execute?: (input: unknown, options: ToolCallOptions) => Promise<unknown>;
  } = {
    type: "dynamic",
    description: mastraTool.description,
    inputSchema,
  };

  if (outputSchema) {
    vercelToolConfig.outputSchema = outputSchema;
  }

  if (typeof mastraTool.execute === "function") {
    vercelToolConfig.execute = async (input, options) => {
      const executionArgs: MastraToolExecuteArgs = { context: input };

      if (options) {
        executionArgs.runtimeContext = options;
      }

      const result = await mastraTool.execute?.(executionArgs, options);

      // Extract MCP content format before validation
      const extractedResult = extractMCPContent(result);

      if (outputSchema) {
        const parsed = outputSchema.safeParse(extractedResult);

        if (!parsed.success) {
          throw new Error(
            `Mastra tool '${displayName}' returned invalid output: ${parsed.error.message}`,
          );
        }

        return parsed.data;
      }

      return extractedResult;
    };
  }

  try {
    return tool(vercelToolConfig);
  } catch (error) {
    if (!isUnrepresentableSchemaError(error)) {
      throw error;
    }

    if (vercelToolConfig.outputSchema) {
      const {
        outputSchema: _unusedOutputSchema,
        ...configWithoutOutputSchema
      } = vercelToolConfig;

      try {
        return tool(configWithoutOutputSchema);
      } catch (errorWithoutOutputSchema) {
        if (!isUnrepresentableSchemaError(errorWithoutOutputSchema)) {
          throw errorWithoutOutputSchema;
        }

        const fallbackConfig = {
          ...configWithoutOutputSchema,
          inputSchema: fallbackInputSchema,
        };

        return tool(fallbackConfig);
      }
    }

    const fallbackConfig = {
      ...vercelToolConfig,
      inputSchema: fallbackInputSchema,
    };

    return tool(fallbackConfig);
  }
}

export function convertMastraToolsToVercelTools(
  mastraTools: Record<string, MastraToolInstance>,
): Record<string, VercelTool> {
  return Object.fromEntries(
    Object.entries(mastraTools).map(([name, mastraTool]) => {
      const pureToolName = extractPureToolName(name);

      return [
        pureToolName,
        convertMastraToolToVercelTool(pureToolName, mastraTool, {
          originalName: name,
        }),
      ];
    }),
  );
}
