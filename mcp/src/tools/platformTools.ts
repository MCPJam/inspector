/**
 * MCP tools over the shared platform operation catalog. Each tool is a thin
 * adapter: parse args with the operation's schema, call the Platform API
 * with the session's bearer token, and emit the payload as both text and
 * structured content. Operations listed in `PLATFORM_TOOL_WIDGET_VIEWS`
 * additionally register the shared MCP Apps bundle as their UI resource —
 * rendered only when the client supports MCP Apps, with the registrar
 * falling back to the plain (untagged) callback otherwise. The widget-backed
 * `show_servers` tool lives in `showServers.ts` and reuses the helpers here.
 */
import {
  callServerToolOperation,
  createEvalSuiteOperation,
  diagnoseServerOperation,
  getChatboxOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  getServerPromptOperation,
  isPlatformApiError,
  listChatboxesOperation,
  listChatSessionsOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listProjectsOperation,
  listProjectServersOperation,
  listServerPromptsOperation,
  listServerResourcesOperation,
  listServerToolsOperation,
  PlatformApiClient,
  readServerResourceOperation,
  runEvalSuiteOperation,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { MCPJAM_APP_HTML } from "../generated/McpAppsHtml.bundled.js";
import {
  PLATFORM_WIDGET_RESOURCE_URIS,
  tagPlatformWidgetPayload,
  type PlatformWidgetView,
} from "../shared/platform-widgets.js";
import type { McpJamMcpServer } from "../server.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";

/** Every catalog operation registered as a tool, in list order. */
export const PLATFORM_CATALOG_OPERATIONS: ReadonlyArray<
  PlatformOperation<any, any>
> = [
  listProjectsOperation,
  listProjectServersOperation,
  diagnoseServerOperation,
  listServerToolsOperation,
  callServerToolOperation,
  listServerPromptsOperation,
  getServerPromptOperation,
  listServerResourcesOperation,
  readServerResourceOperation,
  listEvalSuitesOperation,
  listEvalSuiteRunsOperation,
  runEvalSuiteOperation,
  createEvalSuiteOperation,
  getEvalRunOperation,
  listEvalRunIterationsOperation,
  getEvalIterationTraceOperation,
  listChatboxesOperation,
  getChatboxOperation,
  listChatSessionsOperation,
];

/**
 * Catalog operations that render as MCP Apps widgets, mapped to their view
 * in the shared UI bundle. The rest stay plain: list_projects and
 * list_project_servers defer to the richer show_servers widget,
 * run_eval_suite / create_eval_suite return receipts the run/suite widgets
 * supersede, and get_eval_iteration_trace / list_chat_sessions are
 * agent-oriented payloads with no visual form. `show_servers` itself
 * registers in `showServers.ts`.
 */
export const PLATFORM_TOOL_WIDGET_VIEWS: Readonly<
  Partial<Record<string, PlatformWidgetView>>
> = {
  [listEvalSuitesOperation.name]: "eval_suites",
  [listEvalSuiteRunsOperation.name]: "eval_suite_runs",
  [getEvalRunOperation.name]: "eval_run",
  [listEvalRunIterationsOperation.name]: "eval_run_iterations",
  [listChatboxesOperation.name]: "chatboxes",
  [getChatboxOperation.name]: "chatbox",
};

export function registerPlatformCatalogTools(
  registrar: SessionToolRegistrar,
  agent: McpJamMcpServer
): void {
  for (const operation of PLATFORM_CATALOG_OPERATIONS) {
    const view = PLATFORM_TOOL_WIDGET_VIEWS[operation.name];
    registrar.registerTool(
      operation.name,
      {
        title: operation.title,
        description: operation.description,
        inputSchema: operation.inputSchema,
        annotations: operationAnnotations(operation),
      },
      async (input) => runPlatformOperation(agent, operation, input),
      view ? platformWidgetUi(agent, operation, view) : undefined
    );
  }
}

/**
 * UI registration for a widget-backed tool: the shared app bundle under the
 * view's own resource URI, and a callback whose payload carries the
 * `widget` tag the bundle routes on. The plain callback stays untagged so
 * non-MCP-Apps sessions see the bare operation payload.
 */
export function platformWidgetUi(
  agent: McpJamMcpServer,
  operation: PlatformOperation<any, any>,
  view: PlatformWidgetView
) {
  return {
    resourceUri: PLATFORM_WIDGET_RESOURCE_URIS[view],
    html: MCPJAM_APP_HTML,
    resourceName: `${operation.title} UI`,
    resourceMeta: {
      ui: {
        prefersBorder: true,
      },
    },
    callback: async (input: unknown) =>
      runPlatformOperation(agent, operation, input, (payload) =>
        tagPlatformWidgetPayload(view, payload)
      ),
  };
}

export function operationAnnotations(
  operation: PlatformOperation<unknown, unknown>
): ToolAnnotations {
  if (operation.readOnly) {
    return { readOnlyHint: true };
  }
  // Operations whose effects are unknowable upstream (call_server_tool runs
  // arbitrary third-party tools) omit destructive/idempotent hints on
  // purpose: per spec, clients must then assume destructive — the honest
  // claim.
  if (operation.mayBeDestructive) {
    return { readOnlyHint: false };
  }
  // Remaining non-read operations (run_eval_suite, create_eval_suite) create
  // resources but never destroy or overwrite them.
  return { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
}

export async function runPlatformOperation<TInput, TOutput extends object>(
  agent: McpJamMcpServer,
  operation: PlatformOperation<TInput, TOutput>,
  input: TInput,
  transformPayload?: (payload: TOutput) => object
) {
  // Resolve the bearer: the verified token for an authed session, or a
  // lazily-minted guest token for an anonymous one. Minting happens here (on
  // first tool execution), never at connect/list_tools.
  const token = await agent.getBearerToken();
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
    return toolSuccess(transformPayload ? transformPayload(payload) : payload);
  } catch (error) {
    return toolError(describeOperationError(error), errorStructuredContent(error));
  }
}

// Carry a machine-readable error code into the widget so it can tell an empty
// state (NOT_FOUND: no accessible projects, or a selector that matched nothing)
// apart from a real failure (network, timeout, auth) and render the former
// calmly instead of with the alarming destructive styling. The model/CLI still
// see `isError` plus the human-readable text message.
function errorStructuredContent(
  error: unknown
): Record<string, unknown> | undefined {
  if (isPlatformApiError(error)) {
    return { error: { code: error.code, message: error.message } };
  }
  return undefined;
}

function describeOperationError(error: unknown): string {
  if (isPlatformApiError(error)) {
    // Wire errors keep their stable code for agent retry logic; synthesized
    // client-side errors (status 0) are already self-explanatory messages.
    return error.status > 0 ? `${error.code}: ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

// Cap on the model-visible text rendering. Resource reads, tool schemas,
// and doctor reports are unbounded upstream; hosts feed `content` into model
// context, so an uncapped pretty-print can blow a turn's budget. Mirrors the
// inspector workspace built-ins' MODEL_OUTPUT_CAP philosophy (never fail
// over size, degrade to a readable prefix). `structuredContent` stays
// complete — widgets and programmatic consumers read that, not the text.
const MODEL_TEXT_CAP = 24_000;

function toolSuccess(payload: object) {
  let text = JSON.stringify(payload, null, 2);
  if (text.length > MODEL_TEXT_CAP) {
    text = `${text.slice(0, MODEL_TEXT_CAP)}\n…[truncated ${
      text.length - MODEL_TEXT_CAP
    } chars; the complete payload is in structuredContent]`;
  }
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
    structuredContent: payload as Record<string, unknown>,
  };
}

function toolError(
  message: string,
  structuredContent?: Record<string, unknown>
) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}
