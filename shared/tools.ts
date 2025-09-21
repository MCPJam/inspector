import { z, ZodTypeAny } from "zod";
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

function isZodSchema(value: unknown): value is ZodTypeAny {
  return Boolean(
    value && typeof value === "object" && "safeParse" in (value as ZodTypeAny),
  );
}

function ensureInputSchema(schema: unknown): ZodTypeAny {
  if (isZodSchema(schema)) {
    return schema;
  }

  return fallbackInputSchema;
}

function ensureOutputSchema(schema: unknown): ZodTypeAny | undefined {
  if (isZodSchema(schema)) {
    return schema;
  }

  return undefined;
}

function extractPureToolName(toolKey: string): string {
  const separatorIndex = toolKey.indexOf("_");

  if (separatorIndex === -1 || separatorIndex === toolKey.length - 1) {
    return toolKey;
  }

  return toolKey.slice(separatorIndex + 1);
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

      if (outputSchema) {
        const parsed = outputSchema.safeParse(result);

        if (!parsed.success) {
          throw new Error(
            `Mastra tool '${displayName}' returned invalid output: ${parsed.error.message}`,
          );
        }

        return parsed.data;
      }

      return result;
    };
  }

  return tool(vercelToolConfig);
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
