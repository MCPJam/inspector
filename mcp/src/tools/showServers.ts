import {
  isPlatformApiError,
  listProjectsOperation,
  listProjectServersOperation,
  PlatformApiClient,
  showServersOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import { SHOW_SERVERS_APP_HTML } from "../generated/McpAppsHtml.bundled.js";
import type { McpJamMcpServer } from "../server.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";

export const SHOW_SERVERS_RESOURCE_URI = "ui://mcpjam/show-servers.html";

export function registerShowServersTool(
  registrar: SessionToolRegistrar,
  agent: McpJamMcpServer
): void {
  registrar.registerTool(
    showServersOperation.name,
    {
      title: showServersOperation.title,
      description: showServersOperation.description,
      inputSchema: showServersOperation.inputSchema,
    },
    async (input) => runPlatformOperation(agent, showServersOperation, input),
    {
      resourceUri: SHOW_SERVERS_RESOURCE_URI,
      html: SHOW_SERVERS_APP_HTML,
      resourceName: "MCPJam show servers UI",
      resourceMeta: {
        ui: {
          prefersBorder: true,
        },
      },
      callback: async (input) =>
        runPlatformOperation(agent, showServersOperation, input),
    }
  );
}

export function registerListProjectsTool(
  registrar: SessionToolRegistrar,
  agent: McpJamMcpServer
): void {
  registerPlainOperationTool(registrar, agent, listProjectsOperation);
}

export function registerListProjectServersTool(
  registrar: SessionToolRegistrar,
  agent: McpJamMcpServer
): void {
  registerPlainOperationTool(registrar, agent, listProjectServersOperation);
}

function registerPlainOperationTool<TInput, TOutput extends object>(
  registrar: SessionToolRegistrar,
  agent: McpJamMcpServer,
  operation: PlatformOperation<TInput, TOutput>
): void {
  registrar.registerTool(
    operation.name,
    {
      title: operation.title,
      description: operation.description,
      inputSchema: operation.inputSchema,
    },
    async (input) => runPlatformOperation(agent, operation, input)
  );
}

export async function runPlatformOperation<TInput, TOutput extends object>(
  agent: McpJamMcpServer,
  operation: PlatformOperation<TInput, TOutput>,
  input: TInput
) {
  const token = agent.bearerToken;
  if (!token) {
    return toolError("No bearer token on the request.");
  }

  const client = new PlatformApiClient({
    baseUrl: agent.runtimeEnv.PLATFORM_API_URL,
    getAuth: () => token,
    userAgent: "mcpjam-mcp-worker/0.1.0",
  });

  try {
    const payload = await operation.execute(input, { client });
    return toolSuccess(payload);
  } catch (error) {
    return toolError(describeOperationError(error));
  }
}

function describeOperationError(error: unknown): string {
  if (isPlatformApiError(error)) {
    // Wire errors keep their stable code for agent retry logic; synthesized
    // client-side errors (status 0) are already self-explanatory messages.
    return error.status > 0 ? `${error.code}: ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function toolSuccess(payload: object) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload as Record<string, unknown>,
  };
}

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
