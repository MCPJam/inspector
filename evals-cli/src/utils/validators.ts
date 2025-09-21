import { z, ZodTypeAny } from "zod";
import type {
  LogHandler,
  MastraMCPServerDefinition,
  MCPClientOptions,
} from "@mastra/mcp";
import { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { type Tool as VercelTool } from "ai";
import { convertMastraToolsToVercelTools } from "../../../shared/tools";

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
          server.enableServerLogs = false;
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
          server.enableServerLogs = false;
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

export { convertMastraToolsToVercelTools };

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
