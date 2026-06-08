/**
 * Factory that emits the `SessionToolRegistrar.registerTool` boilerplate for a
 * tool backed by the public API. Each tool declares its name, schemas, and a
 * `run(args, client)` that performs the typed v1 call; the factory wires bearer
 * extraction, client construction, error -> tool-error mapping, and the
 * structured tool result. Mirrors the existing register*Tool pattern
 * (showServers.ts) and stays UI-registrar-aware (a `ui` config can render an
 * MCP App for hosts that support it).
 */
import type { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { SessionToolRegistrar } from "../tools/sessionToolRegistrar.js";
import type { McpJamMcpServer } from "../server.js";
import {
  createPublicApiClient,
  PublicApiError,
  type PublicApiClient,
} from "./public-api-client.js";

export interface PublicApiToolUiConfig {
  resourceUri: string;
  html: string;
  resourceName?: string;
  resourceDescription?: string;
  resourceMeta?: Record<string, unknown>;
}

export interface PublicApiToolDefinition<InputSchema extends z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  outputSchema?: z.ZodTypeAny;
  annotations?: ToolAnnotations;
  /** Perform the v1 call(s) and return the structured payload. */
  run: (
    args: z.infer<InputSchema>,
    client: PublicApiClient
  ) => Promise<unknown>;
  /** Optional MCP App UI for hosts that support resource rendering. */
  ui?: PublicApiToolUiConfig;
}

export function registerPublicApiTool<InputSchema extends z.ZodTypeAny>(
  registrar: SessionToolRegistrar,
  agent: McpJamMcpServer,
  def: PublicApiToolDefinition<InputSchema>
): void {
  const callback = async (args: z.infer<InputSchema>) => {
    const token = agent.bearerToken;
    if (!token) {
      return toolError("No bearer token on the request.");
    }
    const client = createPublicApiClient(agent.runtimeEnv, token);
    try {
      const payload = await def.run(args, client);
      return toolSuccess(payload);
    } catch (error) {
      return toolError(formatError(error));
    }
  };

  registrar.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema as any,
      ...(def.outputSchema ? { outputSchema: def.outputSchema as any } : {}),
      ...(def.annotations ? { annotations: def.annotations } : {}),
    },
    callback as any,
    def.ui
      ? {
          resourceUri: def.ui.resourceUri,
          html: def.ui.html,
          resourceName: def.ui.resourceName,
          resourceDescription: def.ui.resourceDescription,
          resourceMeta: def.ui.resourceMeta,
          callback: callback as any,
        }
      : undefined
  );
}

function toolSuccess(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent:
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : { value: payload },
  };
}

function toolError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function formatError(error: unknown): string {
  if (error instanceof PublicApiError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
