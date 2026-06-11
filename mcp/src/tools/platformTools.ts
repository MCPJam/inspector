/**
 * Plain (no-UI) MCP tools over the shared platform operation catalog. Each
 * tool is a thin adapter: parse args with the operation's schema, call the
 * Platform API with the session's bearer token, and emit the payload as both
 * text and structured content. The widget-backed `show_servers` tool lives in
 * `showServers.ts` and reuses `runPlatformOperation` from here.
 */
import {
  getChatboxOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  isPlatformApiError,
  listChatboxesOperation,
  listChatSessionsOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listProjectsOperation,
  listProjectServersOperation,
  PlatformApiClient,
  runEvalSuiteOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { McpJamMcpServer } from "../server.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";

/**
 * Every catalog operation registered as a plain tool, in list order.
 * `show_servers` is intentionally absent — it registers separately with its
 * MCP Apps UI resource.
 */
export const PLAIN_PLATFORM_OPERATIONS: ReadonlyArray<
  PlatformOperation<any, any>
> = [
  listProjectsOperation,
  listProjectServersOperation,
  listEvalSuitesOperation,
  listEvalSuiteRunsOperation,
  runEvalSuiteOperation,
  getEvalRunOperation,
  listEvalRunIterationsOperation,
  getEvalIterationTraceOperation,
  listChatboxesOperation,
  getChatboxOperation,
  listChatSessionsOperation,
];

export function registerPlainPlatformTools(
  registrar: SessionToolRegistrar,
  agent: McpJamMcpServer
): void {
  for (const operation of PLAIN_PLATFORM_OPERATIONS) {
    registrar.registerTool(
      operation.name,
      {
        title: operation.title,
        description: operation.description,
        inputSchema: operation.inputSchema,
        annotations: operationAnnotations(operation),
      },
      async (input) => runPlatformOperation(agent, operation, input)
    );
  }
}

export function operationAnnotations(
  operation: PlatformOperation<unknown, unknown>
): ToolAnnotations {
  // Non-read operations (run_eval_suite) create resources but never destroy
  // or overwrite them; without the explicit hint, MCP clients must assume
  // destructive (the spec's default for non-read-only tools).
  return operation.readOnly
    ? { readOnlyHint: true }
    : { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
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
    userAgent: "mcpjam-mcp-worker/0.2.0",
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
