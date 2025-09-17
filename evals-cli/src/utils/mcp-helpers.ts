import type {
  LogHandler,
  MastraMCPServerDefinition,
  MCPClientOptions,
} from "@mastra/mcp";
import { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

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
          const normalizedServer = {
            ...(server as Record<string, any>),
            url:
              typeof urlValue === "string"
                ? urlValue
                : (urlValue as URL).toString(),
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
