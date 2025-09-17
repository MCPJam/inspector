import { z, ZodTypeAny } from "zod";
import type {
  LogHandler,
  MastraMCPServerDefinition,
  MCPClientOptions,
} from "@mastra/mcp";
import { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { tool, type Tool as VercelTool, type ToolCallOptions } from "ai";

export const AdvancedConfigSchema = z
  .object({
    system: z.string().optional(),
    temperature: z.number().optional(),
    toolChoice: z.string().optional(),
  })
  .passthrough(); // Allow additional fields

export const TestCaseSchema = z.object({
  title: z.string(),
  query: z.string(),
  runs: z.number().int(),
  model: z.string(),
  provider: z.string(),
  expectedToolCalls: z.array(z.string()),
  judgeRequirement: z.string().optional(),
  advancedConfig: AdvancedConfigSchema.optional(),
});

export type TestCase = z.infer<typeof TestCaseSchema>;

export function validateTestCase(value: unknown): TestCase[] {
  try {
    const result = z.array(TestCaseSchema).parse(value);
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(error.message);
    }
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

const BaseServerOptionsSchema = z.object({
  logger: z.custom<LogHandler>().optional(),
  timeout: z.number().optional(),
  capabilities: z.custom<ClientCapabilities>().optional(),
  enableServerLogs: z.boolean().optional(),
});

const StdioServerDefinitionSchema = BaseServerOptionsSchema.extend({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict();

const HttpServerDefinitionSchema = BaseServerOptionsSchema.extend({
  // Accept either a URL object or a string URL, but we'll normalize to string
  url: z.union([z.string().url(), z.instanceof(URL)]),
  requestInit: z
    .custom<StreamableHTTPClientTransportOptions["requestInit"]>()
    .optional(),
  eventSourceInit: z
    .custom<SSEClientTransportOptions["eventSourceInit"]>()
    .optional(),
  authProvider: z
    .custom<StreamableHTTPClientTransportOptions["authProvider"]>()
    .optional(),
  reconnectionOptions: z
    .custom<StreamableHTTPClientTransportOptions["reconnectionOptions"]>()
    .optional(),
  sessionId: z
    .custom<StreamableHTTPClientTransportOptions["sessionId"]>()
    .optional(),
}).strict();

export const MCPClientOptionsSchema = z.custom<MCPClientOptions>();
export const MastraMCPServerDefinitionSchema = z.union([
  StdioServerDefinitionSchema,
  HttpServerDefinitionSchema,
]);

export function validateAndNormalizeMCPClientConfiguration(
  value: unknown,
): MCPClientOptions {
  try {
    const envParsed = MCPClientOptionsSchema.parse(value);

    const normalizedServers: Record<string, MastraMCPServerDefinition> = {};

    for (const [name, server] of Object.entries(envParsed.servers)) {
      try {
        if (server && typeof server === "object" && "url" in server) {
          MastraMCPServerDefinitionSchema.parse(server);
          const urlValue = (server as any).url;
          const normalizedUrl =
            typeof urlValue === "string"
              ? new URL(urlValue)
              : (urlValue as URL);
          const normalizedServer = {
            ...(server as Record<string, any>),
            url: normalizedUrl,
          } as Record<string, any>;
          normalizedServers[name] =
            normalizedServer as MastraMCPServerDefinition;
        } else {
          MastraMCPServerDefinitionSchema.parse(server);
          normalizedServers[name] = server;
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(
            `Invalid server configuration for '${name}': ${error.message}`,
          );
        }
        throw new Error(`Invalid server configuration for '${name}': ${error}`);
      }
    }

    return {
      ...envParsed,
      servers: normalizedServers,
    };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

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

export const LlmsConfigSchema = z
  .object({
    anthropic: z.string().optional(),
    openai: z.string().optional(),
    openrouter: z.string().optional(),
  })
  .passthrough(); // Allow additional LLM providers

export type LlmsConfig = z.infer<typeof LlmsConfigSchema>;

export function validateLlms(value: unknown): LlmsConfig {
  try {
    const result = LlmsConfigSchema.parse(value);
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid LLMs configuration: ${error.message}`);
    }
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}
