/**
 * MCP tools over the shared platform operation catalog. Each tool is a thin
 * adapter: parse args with the operation's schema, call the Platform API
 * with the request's bearer token, and emit the payload as both text and
 * structured content. Operations listed in `PLATFORM_TOOL_WIDGET_VIEWS`
 * additionally register the shared MCP Apps bundle as their UI resource. The
 * widget-backed `show_servers` tool lives in `showServers.ts` and reuses the
 * helpers here.
 */
import {
  callServerToolOperation,
  checkHostCompatibilityOperation,
  createEvalCaseOperation,
  createEvalSuiteOperation,
  createProjectServerOperation,
  deleteEvalCaseOperation,
  deleteEvalSuiteOperation,
  diagnoseServerOperation,
  getMeOperation,
  listModelsOperation,
  generateEvalCasesOperation,
  cancelEvalRunOperation,
  getChatboxOperation,
  getEvalCaseOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  getEvalRunStepsOperation,
  getEvalSuiteOperation,
  getEnvironmentOperation,
  getPluginVersionOperation,
  getProjectServerOperation,
  getServerPromptOperation,
  isPlatformApiError,
  listChatboxesOperation,
  listChatSessionsOperation,
  listEvalCasesOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listEnvironmentsOperation,
  listProjectPluginsOperation,
  listProjectsOperation,
  listProjectServersOperation,
  listServerPromptsOperation,
  listServerResourcesOperation,
  listServerToolsOperation,
  PlatformApiClient,
  readServerResourceOperation,
  resolveEnvironmentOperation,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  setEvalSuiteEnvironmentsOperation,
  setEvalSuiteScheduleOperation,
  updateEvalCaseOperation,
  updateEvalSuiteOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  deleteProjectOperation,
  ALL_OPERATIONS,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { MCPJAM_APP_HTML } from "../generated/McpAppsHtml.bundled.js";
import {
  PLATFORM_WIDGET_RESOURCE_URIS,
  tagPlatformWidgetPayload,
  type PlatformWidgetView,
} from "../shared/platform-widgets.js";
import type { PlatformToolContext } from "../server.js";
import type { SessionToolRegistrar } from "./sessionToolRegistrar.js";

/** Every catalog operation registered as a tool, in list order. */
export const PLATFORM_CATALOG_OPERATIONS: ReadonlyArray<
  PlatformOperation<any, any>
> = [
  getMeOperation,
  listModelsOperation,
  listProjectsOperation,
  listProjectServersOperation,
  createProjectServerOperation,
  getProjectServerOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  diagnoseServerOperation,
  listServerToolsOperation,
  callServerToolOperation,
  listServerPromptsOperation,
  getServerPromptOperation,
  listServerResourcesOperation,
  readServerResourceOperation,
  checkHostCompatibilityOperation,
  listEvalSuitesOperation,
  listEvalSuiteRunsOperation,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  createEvalSuiteOperation,
  getEvalSuiteOperation,
  updateEvalSuiteOperation,
  deleteEvalSuiteOperation,
  setEvalSuiteScheduleOperation,
  setEvalSuiteEnvironmentsOperation,
  listEvalCasesOperation,
  getEvalCaseOperation,
  createEvalCaseOperation,
  updateEvalCaseOperation,
  deleteEvalCaseOperation,
  generateEvalCasesOperation,
  getEvalRunOperation,
  listEvalRunIterationsOperation,
  getEvalIterationTraceOperation,
  getEvalRunStepsOperation,
  cancelEvalRunOperation,
  listEnvironmentsOperation,
  getEnvironmentOperation,
  resolveEnvironmentOperation,
  // Agent Plugins: the READ half only. Every plugin write (import, activate,
  // enable/disable, uninstall) stays off this unattended surface by policy —
  // there is no excluded write operation to list because the SDK ships none.
  listProjectPluginsOperation,
  getPluginVersionOperation,
  listChatboxesOperation,
  getChatboxOperation,
  listChatSessionsOperation,
];

/** Every SDK operation not exposed by the generic MCP catalog, with policy. */
export const EXCLUDED_FROM_CATALOG: Readonly<Record<string, string>> = {
  launch_journey_run: "Pre-GA product — expose at GA.",
  cancel_journey_run: "Pre-GA product — expose with the launch it pairs with.",
  // Scenarios (user testing) and journeys (Swarms) are held out of this
  // catalog WHOLESALE until GA — a CATALOG policy, not the flag.
  //
  // The distinction matters, because a maintainer who reads "flag-gated" here
  // will reach for the flag when deciding what to expose, and the flag does
  // not cover most of this list. `sandboxes-enabled` gates only the
  // exposure-CREATING writes (publish, launch, authoring); the reads,
  // `cancel_journey_run` and `unpublish_scenario` are deliberately ungated, so
  // an organization that has just lost the flag can still see what is running,
  // stop it, and take a live scenario down. None of them ever answers
  // FEATURE_UNAVAILABLE. What keeps them out is that this catalog is STATIC —
  // one tool list for every caller, built with no organization in hand — so a
  // beta cannot be advertised selectively here at all.
  publish_scenario:
    "Pre-GA product, and publishing exposes an environment publicly — not an unattended-catalog action.",
  unpublish_scenario:
    "Pre-GA product — expose at GA, with its publish counterpart.",
  list_journeys: "Pre-GA product — expose at GA.",
  list_journey_runs: "Pre-GA product — expose at GA.",
  get_journey_run: "Pre-GA product — expose at GA.",
  list_journey_run_sessions: "Pre-GA product — expose at GA.",

  show_servers: "Registered by the dedicated show_servers MCP Apps tool.",
  create_project:
    "Project lifecycle writes are intentionally outside the unattended MCP catalog.",
  update_project:
    "Project lifecycle writes are intentionally outside the unattended MCP catalog.",
  delete_project:
    "Project lifecycle writes are intentionally outside the unattended MCP catalog.",
  validate_server:
    "Server validation is available through the dedicated server diagnostics surface.",
  export_server:
    "Server export is available through the dedicated server diagnostics surface.",
  list_hosts:
    "Host administration is intentionally outside the generic MCP catalog.",
  get_host:
    "Host administration is intentionally outside the generic MCP catalog.",
  set_host_servers:
    "Host infrastructure writes are intentionally outside the unattended MCP catalog.",
  duplicate_host:
    "Host infrastructure writes are intentionally outside the unattended MCP catalog.",
  list_sandbox_images:
    "Sandbox image lifecycle is intentionally outside the generic MCP catalog.",
  get_sandbox_image:
    "Sandbox image lifecycle is intentionally outside the generic MCP catalog.",
  validate_sandbox_image_blueprint:
    "Sandbox image lifecycle is intentionally outside the generic MCP catalog.",
  list_sandbox_image_builds:
    "Sandbox image lifecycle is intentionally outside the generic MCP catalog.",
  create_tunnel:
    "Tunnel lifecycle is exposed through the dedicated CLI and tunnel surface.",
  close_tunnel:
    "Tunnel lifecycle is exposed through the dedicated CLI and tunnel surface.",
  create_host:
    "Project infrastructure writes are not offered on the unattended catalog surface.",
  update_host:
    "Project infrastructure writes are not offered on the unattended catalog surface.",
  delete_host:
    "Project infrastructure writes are not offered on the unattended catalog surface.",
  create_project_environment:
    "Project infrastructure writes are not offered on the unattended catalog surface.",
  update_project_environment:
    "Project infrastructure writes are not offered on the unattended catalog surface.",
  archive_project_environment:
    "Project infrastructure writes are not offered on the unattended catalog surface.",
  restore_project_environment:
    "Project infrastructure writes are not offered on the unattended catalog surface.",
  create_sandbox_image:
    "Sandbox image lifecycle writes are not offered on the unattended catalog surface.",
  update_sandbox_image:
    "Sandbox image lifecycle writes are not offered on the unattended catalog surface.",
  build_sandbox_image:
    "Sandbox image lifecycle writes are not offered on the unattended catalog surface.",
  promote_sandbox_image:
    "Sandbox image lifecycle writes are not offered on the unattended catalog surface.",
  use_sandbox_image:
    "Sandbox image lifecycle writes are not offered on the unattended catalog surface.",
  reset_computer:
    "Computer lifecycle writes are not offered on the unattended catalog surface.",
  delete_sandbox_image:
    "Sandbox image lifecycle writes are not offered on the unattended catalog surface.",
};

const catalogOperationNames = new Set(
  PLATFORM_CATALOG_OPERATIONS.map((operation) => operation.name)
);
const allOperationNames = new Set(
  ALL_OPERATIONS.map((operation) => operation.name)
);
const staleCatalogExclusions = Object.keys(EXCLUDED_FROM_CATALOG).filter(
  (name) => !allOperationNames.has(name)
);
const uncoveredCatalogOperations = ALL_OPERATIONS.filter(
  (operation) =>
    !catalogOperationNames.has(operation.name) &&
    !Object.prototype.hasOwnProperty.call(EXCLUDED_FROM_CATALOG, operation.name)
);
if (
  staleCatalogExclusions.length > 0 ||
  uncoveredCatalogOperations.length > 0
) {
  throw new Error(
    `Platform MCP catalog partition drift: stale=${staleCatalogExclusions.join(
      ","
    )}; uncovered=${uncoveredCatalogOperations
      .map((operation) => operation.name)
      .join(",")}`
  );
}

/**
 * Operations that PERMANENTLY destroy a known resource. They carry an
 * explicit `destructiveHint: true` (unlike `mayBeDestructive` ops, whose
 * effects are merely unknowable). Kept here rather than on the SDK operation
 * so the wire contract stays surface-agnostic.
 */
const DESTRUCTIVE_OPERATION_NAMES: ReadonlySet<string> = new Set([
  deleteEvalSuiteOperation.name,
  deleteEvalCaseOperation.name,
  deleteProjectServerOperation.name,
  deleteProjectOperation.name,
  // Cancelling a run terminates in-flight work — state-changing, so clients
  // should be able to confirm before it fires.
  cancelEvalRunOperation.name,
]);

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
  context: PlatformToolContext
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
      async (input) => runPlatformOperation(context, operation, input),
      view ? platformWidgetUi(context, operation, view) : undefined
    );
  }
}

/**
 * UI registration for a widget-backed tool: the shared app bundle under the
 * view's own resource URI, and a callback whose payload carries the
 * `widget` tag the bundle routes on. This is the callback a widget-backed
 * tool actually registers; the untagged one passed alongside it is the
 * fallback for tools that declare a UI resource but need no payload tag.
 */
export function platformWidgetUi(
  context: PlatformToolContext,
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
      runPlatformOperation(context, operation, input, (payload) =>
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
  // Known-destructive deletes: announce it explicitly so clients can confirm.
  if (DESTRUCTIVE_OPERATION_NAMES.has(operation.name)) {
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
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
  context: PlatformToolContext,
  operation: PlatformOperation<TInput, TOutput>,
  input: TInput,
  transformPayload?: (payload: TOutput) => object
) {
  // Resolve the bearer: the verified token for an authed session, or a
  // lazily-minted guest token for an anonymous one. Minting happens here (on
  // first tool execution), never at connect/list_tools.
  const token = await context.getBearerToken();
  if (!token) {
    return toolError("No bearer token on the request.");
  }

  const client = new PlatformApiClient({
    baseUrl: context.runtimeEnv.PLATFORM_API_URL,
    getAuth: () => token,
    userAgent: "mcpjam-mcp-worker/0.2.0",
  });

  try {
    const payload = await operation.execute(input, { client });
    return toolSuccess(transformPayload ? transformPayload(payload) : payload);
  } catch (error) {
    return toolError(
      describeOperationError(error),
      errorStructuredContent(error)
    );
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
