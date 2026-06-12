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
  getChatboxOperation,
  getEvalIterationTraceOperation,
  getEvalRunOperation,
  getServerPromptOperation,
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
  readServerResourceOperation,
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
  getEvalRunOperation,
  listEvalRunIterationsOperation,
  getEvalIterationTraceOperation,
  listChatboxesOperation,
  getChatboxOperation,
  listChatSessionsOperation,
];

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
function capForModel(value: unknown): unknown {
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
function toToolError(error: unknown, fallback: string): { error: string } {
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
    CONNECTION_OPENING_IDS.has(id) && opts.requireToolApproval === true;

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
