/**
 * The hosted MCP server's eval tools, served by `mcpjam mcp --evals` with the
 * CLI's own sign-in against the server the CLI resolves. Each tool's
 * annotations, spend notice and result shape come from the SDK code the
 * hosted server uses, so an agent gets the same eval tools from either one.
 */
import {
  ALL_OPERATIONS,
  isPlatformApiError,
  runOperationWithPermalinks,
  withPermalinkEnvelope,
  type PlatformApiClient,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import {
  describeOperationError,
  errorStructuredContent,
  localEvalToolNames,
  MCP_RESULT_PROJECTIONS,
  operationAnnotations,
  operationDescription,
  toolError,
  toolSuccess,
  type EvalToolName,
} from "@mcpjam/sdk/internal/mcp-surface";
import type { McpServer } from "@modelcontextprotocol/server";
import { preflightCloudCredentials } from "./cloud-context.js";
import { describeCloudCredential } from "./credential-describe.js";
import { reportToolCall, type OnToolCalled } from "./mcp-tool-runner.js";
import { CliError } from "./output.js";
import { buildPlatformClient } from "./platform-client.js";

/** A client for one tool call, and the app origin its permalinks point at. */
export interface EvalToolClient {
  client: PlatformApiClient;
  appOrigin: string;
}

/** `callerName` is the MCP client's own name, which the run shows as its launcher. */
export type ResolveEvalToolClient = (
  callerName: string | undefined,
) => EvalToolClient;

export const EVAL_TOOLS_SIGN_IN_MESSAGE =
  "MCPJam's eval tools need your MCPJam sign-in. Run `mcpjam cloud login` in a terminal, or set MCPJAM_API_KEY in this server's env in your MCP client's config, then call the tool again. MCP clients don't pass your shell's environment to a server they start.";

class SignInRequiredError extends Error {
  readonly code = "AUTH_REQUIRED";
}

/**
 * Resolved on every call, so a login made after the server started is used,
 * and so is a token the CLI refreshed since.
 */
export const resolveCliEvalToolClient: ResolveEvalToolClient = (callerName) => {
  if (describeCloudCredential({}).credential.source === "missing") {
    throw new SignInRequiredError(EVAL_TOOLS_SIGN_IN_MESSAGE);
  }
  preflightCloudCredentials({});
  const built = buildPlatformClient({
    launcher: { kind: "mcp", ...(callerName ? { client: callerName } : {}) },
  });
  return { client: built.client, appOrigin: new URL(built.baseUrl).origin };
};

/** The local eval tools, resolved against the catalog this process calls. */
export function localEvalToolOperations(): PlatformOperation<object, object>[] {
  const byName = new Map(
    ALL_OPERATIONS.map((operation) => [operation.name, operation]),
  );
  return localEvalToolNames().map((name) => {
    const operation = byName.get(name);
    if (!operation) {
      throw new Error(`The SDK's eval tool group names an unknown operation: ${name}`);
    }
    return operation as PlatformOperation<object, object>;
  });
}

function errorCodeOf(error: unknown): string {
  if (isPlatformApiError(error) || error instanceof CliError) return error.code;
  if (error instanceof SignInRequiredError) return error.code;
  return "INTERNAL_ERROR";
}

export function registerEvalTools(
  server: McpServer,
  options: {
    onToolCalled?: OnToolCalled;
    resolveClient?: ResolveEvalToolClient;
  } = {},
): EvalToolName[] {
  const resolveClient = options.resolveClient ?? resolveCliEvalToolClient;
  const operations = localEvalToolOperations();
  for (const operation of operations) {
    const name = operation.name as EvalToolName;
    server.registerTool(
      name,
      {
        title: operation.title,
        description: operationDescription(operation),
        inputSchema: operation.inputSchema,
        annotations: operationAnnotations(operation),
      },
      async (input: object) => {
        const startedAt = Date.now();
        const report = (success: boolean, errorCode?: string) =>
          reportToolCall(options.onToolCalled, {
            tool: name,
            success,
            durationMs: Date.now() - startedAt,
            ...(success ? {} : { errorCode }),
          });
        try {
          const { client, appOrigin } = resolveClient(
            server.server.getClientVersion()?.name,
          );
          const projection = MCP_RESULT_PROJECTIONS[name];
          const { result, permalinks } = await runOperationWithPermalinks(
            operation,
            input,
            { client },
            { appOrigin },
          );
          report(true);
          return toolSuccess(
            withPermalinkEnvelope(
              projection ? projection(result) : result,
              permalinks,
            ),
            permalinks,
          );
        } catch (error) {
          report(false, errorCodeOf(error));
          return toolError(
            describeOperationError(error),
            errorStructuredContent(error),
          );
        }
      },
    );
  }
  return operations.map((operation) => operation.name as EvalToolName);
}
