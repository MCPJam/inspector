/**
 * MCPJam workspace built-in tools — the in-product surface of the shared
 * platform operation catalog (`@mcpjam/sdk/platform`).
 *
 * Each tool IS a `PlatformOperation`, adapted per the catalog's design
 * ("defined once and adapted per surface"): name, description, input schema,
 * and execute come from the operation — identical to the MCP worker's tools
 * — so the catalog ids registered in the backend `builtInTools` table are
 * the operation names, unchanged. The operations call the platform's own
 * `/api/v1`; in-app the injected `PlatformApiClient` self-dispatches into
 * this server's Hono app (see routes/web/mcpjam-platform-client.ts), so no
 * forked handler logic and no network hop.
 *
 * The one per-surface adaptation is ambient project scoping: every operation
 * takes an optional `project` selector that defaults to "most recently
 * updated" for external callers with no context. In a chat there IS ambient
 * context, so an omitted `project` defaults to the chat's project instead —
 * an input default, not a schema fork. An explicit `project` still works
 * (the agent may roam; authority is the caller's bearer either way), which
 * is why this is a default rather than a clamp.
 *
 * Approval policy: operations that open a connection to a saved MCP server
 * inherit the host's `requireToolApproval`, mirroring the blanket approval
 * MCP tools get from the orchestration layer. `list_project_servers` is a
 * pure platform read and never needs approval, like `web_search`.
 *
 * `execute` returns `{ error: string }` instead of throwing so the model can
 * relay problems conversationally instead of breaking the turn. Results are
 * capped before they reach model context (`MODEL_OUTPUT_CAP`).
 */
import { tool, type ToolSet } from "ai";
import {
  callServerToolOperation,
  diagnoseServerOperation,
  cancelEvalRunOperation,
  getChatboxOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  getEvalRunStepsOperation,
  getServerPromptOperation,
  listChatboxesOperation,
  listChatSessionsOperation,
  listEvalRunIterationsOperation,
  listEvalSuiteRunsOperation,
  listEvalSuitesOperation,
  listProjectsOperation,
  createProjectServerOperation,
  getProjectServerOperation,
  updateProjectServerOperation,
  deleteProjectServerOperation,
  listProjectServersOperation,
  listServerPromptsOperation,
  listServerResourcesOperation,
  listServerToolsOperation,
  readServerResourceOperation,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  type PlatformApiClient,
  type PlatformOperation,
} from "@mcpjam/sdk/platform";

// The workspace toolset, in advertise order. Mirrors PLATFORM_CATALOG_OPERATIONS
// in mcp/src/tools/platformTools.ts — both surfaces pull from the same SDK
// operations. showServersOperation is intentionally omitted (MCP Apps widget only).
const WORKSPACE_OPERATIONS: ReadonlyArray<PlatformOperation<any, unknown>> = [
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
  listEvalSuitesOperation,
  listEvalSuiteRunsOperation,
  runEvalCaseOperation,
  runEvalSuiteOperation,
  getEvalRunOperation,
  listEvalRunIterationsOperation,
  getEvalIterationTraceOperation,
  getEvalRunStepsOperation,
  cancelEvalRunOperation,
  listChatboxesOperation,
  getChatboxOperation,
  listChatSessionsOperation,
];

/**
 * Explicit policy for operations intentionally kept off the in-app chat toolset.
 *
 * WRITTEN OUT, not derived. A map computed as "everything the toolset lacks"
 * makes the partition exact by construction — it can never fail, and every
 * operation added to the SDK arrives here silently pre-excused. Naming each one
 * means advertising it in chat requires deleting a line.
 *
 * Enforced by `__tests__/mcpjam-built-in-tools.test.ts`, not by a module-load
 * throw: a drifted list should fail the build, not refuse to boot the server.
 */
export const EXCLUDED_FROM_WORKSPACE: Readonly<Record<string, string>> = {
  // Identity and catalogs the surrounding UI already owns. Chat runs inside a
  // chosen project; re-offering the pickers as tools invites the model to
  // wander out of the surface the person is looking at.
  get_me: "The chat surface already knows who is signed in.",
  list_models: "Model choice is the chat UI's own control, not a tool call.",

  // Project and org lifecycle. The UI has dedicated flows with confirmations,
  // and these reshape what the rest of the app is showing.
  create_project:
    "Project creation has a dedicated UI flow with its own guardrails.",
  update_project: "Project settings live in the settings surface.",
  delete_project:
    "Irreversible and cascades; the UI requires an explicit confirmation.",

  // Eval AUTHORING. Chat can read evals and run them; composing suites and
  // cases is the Evaluate tab's own editor, which shows validation inline.
  create_eval_suite: "Suite authoring belongs to the Evaluate editor.",
  get_eval_suite: "Covered by list_eval_suites plus the Evaluate tab itself.",
  update_eval_suite: "Suite authoring belongs to the Evaluate editor.",
  delete_eval_suite: "Irreversible delete; the Evaluate tab confirms it.",
  set_eval_suite_schedule:
    "A recurring spend commitment, set deliberately in the UI.",
  set_eval_suite_environments:
    "Attachment changes silently redirect every later run.",
  list_eval_cases: "Case-level browsing is the Evaluate tab's job.",
  get_eval_case: "Case-level browsing is the Evaluate tab's job.",
  create_eval_case: "Case authoring belongs to the Evaluate editor.",
  update_eval_case: "Case authoring belongs to the Evaluate editor.",
  delete_eval_case: "Irreversible delete; the Evaluate tab confirms it.",
  generate_eval_cases:
    "Spends model quota; the Evaluate tab offers it explicitly.",

  // Host and environment administration: re-wires the execution surface.
  list_hosts: "Host administration has its own tab.",
  get_host: "Host administration has its own tab.",
  create_host: "Host creation re-wires the execution surface.",
  update_host: "Host config changes affect every later run.",
  delete_host: "Irreversible and rotates every host config that referenced it.",
  set_host_servers:
    "Re-wiring a host's server set is an administrative action.",
  duplicate_host: "Host administration has its own tab.",
  list_project_environments: "Environments have their own tab.",
  get_project_environment: "Environments have their own tab.",
  resolve_project_environment: "Resolution detail with no chat-facing use.",
  create_project_environment: "Environment authoring has its own editor.",
  update_project_environment: "Environment authoring has its own editor.",
  archive_project_environment: "Environment lifecycle has its own controls.",
  restore_project_environment: "Environment lifecycle has its own controls.",

  // Sandbox images and computers: minutes-long builds and billable compute.
  list_sandbox_images:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  get_sandbox_image:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  create_sandbox_image:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  update_sandbox_image:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  validate_sandbox_image_blueprint:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  build_sandbox_image:
    "Runs for minutes and bills compute; it cannot complete in a chat turn.",
  list_sandbox_image_builds:
    "Image lifecycle is an operator surface (CLI / Computer tab).",
  promote_sandbox_image: "Promotion changes what every later run executes on.",
  use_sandbox_image: "Binding an image to a project is an operator decision.",
  delete_sandbox_image: "Irreversible; image lifecycle is an operator task.",
  reset_computer: "Destroys live sandbox state the person may still be using.",

  // Long-running or connection-opening work a chat turn cannot own.
  check_host_compatibility:
    "Scans a whole catalog; it cannot finish inside a turn.",
  create_tunnel: "Opens a long-lived local process the turn cannot close.",
  close_tunnel: "Tunnel lifecycle belongs to whoever opened it.",
  validate_server:
    "Opens a live connection; diagnose_server covers the chat need.",
  export_server: "Emits a full server config including its auth shape.",
  show_servers:
    "The widget-bearing variant for MCP Apps hosts, not in-app chat.",
};

const OPERATIONS_BY_ID = new Map(
  WORKSPACE_OPERATIONS.map((operation) => [operation.name, operation])
);

export const MCPJAM_TOOL_IDS: ReadonlyArray<string> = WORKSPACE_OPERATIONS.map(
  (operation) => operation.name
);

export function isMcpjamToolId(id: string): boolean {
  return OPERATIONS_BY_ID.has(id);
}

// Operations that open an ephemeral connection to a user's saved MCP server
// inherit the host's requireToolApproval. Pure platform API reads (project,
// eval, chatbox) never need approval.
const CONNECTION_OPENING_IDS = new Set([
  diagnoseServerOperation.name,
  listServerToolsOperation.name,
  callServerToolOperation.name,
  listServerPromptsOperation.name,
  getServerPromptOperation.name,
  listServerResourcesOperation.name,
  readServerResourceOperation.name,
]);

// Operations that mutate state and therefore require user approval when the
// host enables it — connection-opening tools plus state-changing writes like
// cancelling an in-flight eval run.
const APPROVAL_REQUIRED_IDS = new Set([
  ...CONNECTION_OPENING_IDS,
  cancelEvalRunOperation.name,
  createProjectServerOperation.name,
  updateProjectServerOperation.name,
  deleteProjectServerOperation.name,
]);

// Surface note appended to each operation's description: in-app, an omitted
// `project` means the chat's project, not the catalog's "most recently
// updated" default for context-free callers.
const AMBIENT_PROJECT_NOTE =
  " When no project is given, the current chat's project is used.";

export interface McpjamToolOptions {
  /**
   * Platform API client bound to the caller's bearer. In the web chat this
   * self-dispatches into the server's own /api/v1 (no network hop).
   */
  client: PlatformApiClient;
  /** The chat's ambient project — the default when `project` is omitted. */
  projectId: string;
  /** Host's approval policy — connection-opening ops must honor it. */
  requireToolApproval?: boolean;
}

// Cap on serialized result size before it reaches model context. Doctor
// reports and resource contents are unbounded upstream; a tool list with
// large schemas can be too.
const MODEL_OUTPUT_CAP = 24_000;

/**
 * Pass small results through untouched; large ones degrade to a truncated
 * JSON preview the model can still read names out of (same philosophy as
 * bash's stdout cap — never fail the turn over size).
 */
export function capForModel(value: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    return { error: "Result could not be serialized." };
  }
  if (json.length <= MODEL_OUTPUT_CAP) return value;
  return {
    truncated: true,
    preview: `${json.slice(0, MODEL_OUTPUT_CAP)}…[truncated ${
      json.length - MODEL_OUTPUT_CAP
    } chars]`,
  };
}

/** Map a thrown error to the `{ error }` envelope, preferring its message. */
export function toToolError(
  error: unknown,
  fallback: string
): { error: string } {
  const message =
    error instanceof Error && error.message.trim() ? error.message : "";
  return { error: message || fallback };
}

/**
 * Build one workspace tool from its catalog operation. Returns `null` for an
 * id outside the workspace set (the registry warns and skips).
 */
export function buildMcpjamTool(
  id: string,
  opts: McpjamToolOptions
): ToolSet[string] | null {
  const operation = OPERATIONS_BY_ID.get(id);
  if (!operation) return null;

  const needsApproval =
    APPROVAL_REQUIRED_IDS.has(id) && opts.requireToolApproval === true;

  return tool({
    description: `${operation.description}${AMBIENT_PROJECT_NOTE}`,
    inputSchema: operation.inputSchema,
    needsApproval,
    execute: async (input: Record<string, unknown>, { abortSignal }) => {
      if (abortSignal?.aborted) {
        return { error: `${operation.title} was cancelled.` };
      }
      // Ambient default, not a clamp: an explicit `project` (name or id)
      // wins; only an omitted/blank one resolves to the chat's project.
      // Trimmed here for raw callers — schema-validated input arrives
      // pre-trimmed via zod's .trim().
      const trimmedProject =
        typeof input.project === "string" ? input.project.trim() : "";
      const project = trimmedProject || opts.projectId;
      try {
        const result = await operation.execute(
          { ...input, project },
          { client: opts.client, signal: abortSignal }
        );
        return capForModel(result);
      } catch (error) {
        if (abortSignal?.aborted) {
          return { error: `${operation.title} was cancelled.` };
        }
        return toToolError(error, `${operation.title} failed.`);
      }
    },
  });
}
