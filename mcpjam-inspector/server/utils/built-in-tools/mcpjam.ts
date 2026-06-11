/**
 * MCPJam product tools (`mcpjam_*`): built-in tools that let the chat agent
 * act on the user's MCPJam workspace itself — list the project's servers,
 * diagnose a connection, and run live MCP operations (tools/prompts/resources)
 * against any saved server, not just the ones selected into the chat.
 *
 * Two execution shapes, mirroring the public `/api/v1` split:
 *
 *   - Catalog reads (`mcpjam_list_servers`, `mcpjam_list_eval_suites`) proxy
 *     the Convex `/v1/*` read surface with the caller's bearer — the same
 *     backing the Inspector's `/api/v1/catalog/*` routes use. They need only
 *     the auth context, so they work on every engine the registry serves.
 *
 *   - Live server ops (`mcpjam_diagnose_server`, `mcpjam_list_tools`,
 *     `mcpjam_call_tool`, prompts/resources) need the authorize → connect →
 *     run pipeline, which lives in the web route layer. The chat route
 *     provides it as a `McpjamLiveOps` runner bound to its request context;
 *     surfaces that don't pass one (eval runners, sessionSimulation) simply
 *     never advertise these tools — same pattern as `computer` and bash.
 *
 * Every `execute` returns a structured `{ error }` instead of throwing so the
 * model can relay the problem to the user instead of breaking the turn.
 * `mcpjam_call_tool` is the only side-effectful tool here and honors the
 * host's `requireToolApproval` policy exactly like bash does.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";

export const MCPJAM_LIST_SERVERS_TOOL_NAME = "mcpjam_list_servers";
export const MCPJAM_LIST_EVAL_SUITES_TOOL_NAME = "mcpjam_list_eval_suites";
export const MCPJAM_DIAGNOSE_SERVER_TOOL_NAME = "mcpjam_diagnose_server";
export const MCPJAM_LIST_TOOLS_TOOL_NAME = "mcpjam_list_tools";
export const MCPJAM_CALL_TOOL_TOOL_NAME = "mcpjam_call_tool";
export const MCPJAM_LIST_PROMPTS_TOOL_NAME = "mcpjam_list_prompts";
export const MCPJAM_GET_PROMPT_TOOL_NAME = "mcpjam_get_prompt";
export const MCPJAM_LIST_RESOURCES_TOOL_NAME = "mcpjam_list_resources";
export const MCPJAM_READ_RESOURCE_TOOL_NAME = "mcpjam_read_resource";

/** Catalog ids (== AI SDK tool names) this module implements. */
export const MCPJAM_TOOL_IDS = [
  MCPJAM_LIST_SERVERS_TOOL_NAME,
  MCPJAM_LIST_EVAL_SUITES_TOOL_NAME,
  MCPJAM_DIAGNOSE_SERVER_TOOL_NAME,
  MCPJAM_LIST_TOOLS_TOOL_NAME,
  MCPJAM_CALL_TOOL_TOOL_NAME,
  MCPJAM_LIST_PROMPTS_TOOL_NAME,
  MCPJAM_GET_PROMPT_TOOL_NAME,
  MCPJAM_LIST_RESOURCES_TOOL_NAME,
  MCPJAM_READ_RESOURCE_TOOL_NAME,
] as const;

export type McpjamToolId = (typeof MCPJAM_TOOL_IDS)[number];

export function isMcpjamToolId(id: string): id is McpjamToolId {
  return (MCPJAM_TOOL_IDS as readonly string[]).includes(id);
}

/**
 * Live MCP operations against a saved server in the current project,
 * authorized as the acting user. Implemented by the chat route over the same
 * authorize → connect → run pipeline as `/api/web/*` and `/api/v1/*`
 * (`server/routes/web/mcpjam-live-ops.ts`); ops throw `WebRouteError` on
 * authorization/transport failures, which the tools translate to `{ error }`.
 */
export interface McpjamLiveOps {
  doctor(serverId: string): Promise<unknown>;
  listTools(serverId: string, cursor?: string): Promise<unknown>;
  callTool(
    serverId: string,
    toolName: string,
    parameters: Record<string, unknown>
  ): Promise<unknown>;
  listPrompts(serverId: string, cursor?: string): Promise<unknown>;
  getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>
  ): Promise<unknown>;
  listResources(serverId: string, cursor?: string): Promise<unknown>;
  readResource(serverId: string, uri: string): Promise<unknown>;
}

export interface McpjamToolOptions {
  /** Bearer authorization header forwarded to Convex (already normalized). */
  authHeader: string;
  /** Project whose catalog and servers the tools operate on. */
  projectId: string;
  /** Live-op runner; absent on engines that can't run live MCP ops. */
  liveOps?: McpjamLiveOps;
  /** Host's approval policy — applied to the side-effectful call tool. */
  requireToolApproval?: boolean;
}

const serverIdField = z
  .string()
  .min(1)
  .describe(
    "MCPJam server id from mcpjam_list_servers (not the server's display name)"
  );

const cursorField = z
  .string()
  .optional()
  .describe("Opaque pagination cursor from a previous call");

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The operation failed. Please try again.";
}

/** Run a live op, translating thrown route errors into `{ error }`. */
async function runLiveOp<T>(
  op: () => Promise<T>,
  abortSignal: AbortSignal | undefined,
  what: string
): Promise<T | { error: string }> {
  try {
    return await op();
  } catch (error) {
    if (abortSignal?.aborted) return { error: `${what} was cancelled.` };
    return { error: errorMessage(error) };
  }
}

/**
 * GET a Convex `/v1/*` catalog read with the caller's bearer — the same
 * backing surface as the Inspector's `/api/v1/catalog/*` proxies. Returns the
 * upstream body verbatim on success (it already carries the public
 * `{ items, nextCursor? }` envelope) and `{ error }` on any failure.
 */
async function convexCatalogRead(
  opts: McpjamToolOptions,
  path: string,
  params: Record<string, string>,
  abortSignal: AbortSignal | undefined,
  what: string
): Promise<unknown> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    return { error: `${what} is not configured on this server.` };
  }
  try {
    const target = new URL(path, convexUrl);
    for (const [name, value] of Object.entries(params)) {
      target.searchParams.set(name, value);
    }
    const res = await fetch(target, {
      method: "GET",
      headers: { Authorization: opts.authHeader },
      signal: abortSignal,
    });
    const body = (await res.json().catch(() => null)) as {
      message?: unknown;
    } | null;
    if (!res.ok) {
      const message =
        body && typeof body.message === "string" && body.message.trim()
          ? body.message
          : `${what} failed (${res.status}).`;
      return { error: message };
    }
    return body ?? { error: `${what} returned an empty response.` };
  } catch (error) {
    if (abortSignal?.aborted) return { error: `${what} was cancelled.` };
    return { error: `${what} failed. Please try again.` };
  }
}

function buildListServersTool(opts: McpjamToolOptions): ToolSet[string] {
  return tool({
    description:
      "List the MCP servers saved in this MCPJam project — including ones " +
      "not connected to this chat. Returns each server's id (used by the " +
      "other mcpjam_* tools), name, and connection metadata.",
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }) =>
      convexCatalogRead(
        opts,
        "/v1/project-servers",
        { projectId: opts.projectId },
        abortSignal,
        "Listing servers"
      ),
  });
}

function buildListEvalSuitesTool(opts: McpjamToolOptions): ToolSet[string] {
  return tool({
    description:
      "List the eval suites in this MCPJam project, with latest-run " +
      "summaries. Use this to answer questions about the project's evals " +
      "and their most recent results.",
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }) =>
      convexCatalogRead(
        opts,
        "/v1/eval-suites",
        { projectId: opts.projectId },
        abortSignal,
        "Listing eval suites"
      ),
  });
}

function buildDiagnoseServerTool(liveOps: McpjamLiveOps): ToolSet[string] {
  return tool({
    description:
      "Diagnose an MCP server saved in this project: probe the endpoint, " +
      "connect, initialize, and report capabilities. Use this when a server " +
      "is failing to connect or behaving unexpectedly — the report explains " +
      "which step failed and why.",
    inputSchema: z.object({ serverId: serverIdField }),
    execute: async ({ serverId }, { abortSignal }) =>
      runLiveOp(() => liveOps.doctor(serverId), abortSignal, "Diagnosis"),
  });
}

function buildListToolsTool(liveOps: McpjamLiveOps): ToolSet[string] {
  return tool({
    description:
      "List the tools an MCP server in this project exposes (name, " +
      "description, input schema). Works for any saved server, including " +
      "ones not connected to this chat. Check schemas here before calling " +
      "mcpjam_call_tool.",
    inputSchema: z.object({ serverId: serverIdField, cursor: cursorField }),
    execute: async ({ serverId, cursor }, { abortSignal }) =>
      runLiveOp(
        () => liveOps.listTools(serverId, cursor),
        abortSignal,
        "Listing tools"
      ),
  });
}

function buildCallToolTool(
  opts: McpjamToolOptions,
  liveOps: McpjamLiveOps
): ToolSet[string] {
  return tool({
    description:
      "Execute a tool on an MCP server saved in this project and return the " +
      "result. The tool runs with the user's credentials and may have side " +
      "effects — only call it when the user asked for the action. Use " +
      "mcpjam_list_tools first to get exact tool names and input schemas. A " +
      "result with isError=true means the server answered with a tool-level " +
      "failure; relay it to the user.",
    inputSchema: z.object({
      serverId: serverIdField,
      toolName: z.string().min(1).describe("Exact tool name on the server"),
      parameters: z
        .record(z.unknown())
        .optional()
        .describe("Tool arguments matching the tool's input schema"),
    }),
    // Executing arbitrary tools on the user's servers must honor the host's
    // approval policy exactly like MCP/skill tools do.
    needsApproval: opts.requireToolApproval === true,
    execute: async ({ serverId, toolName, parameters }, { abortSignal }) =>
      runLiveOp(
        () => liveOps.callTool(serverId, toolName, parameters ?? {}),
        abortSignal,
        "Tool execution"
      ),
  });
}

function buildListPromptsTool(liveOps: McpjamLiveOps): ToolSet[string] {
  return tool({
    description:
      "List the prompts an MCP server in this project exposes (name, " +
      "description, arguments).",
    inputSchema: z.object({ serverId: serverIdField, cursor: cursorField }),
    execute: async ({ serverId, cursor }, { abortSignal }) =>
      runLiveOp(
        () => liveOps.listPrompts(serverId, cursor),
        abortSignal,
        "Listing prompts"
      ),
  });
}

function buildGetPromptTool(liveOps: McpjamLiveOps): ToolSet[string] {
  return tool({
    description:
      "Render a prompt from an MCP server in this project with the given " +
      "arguments and return its messages.",
    inputSchema: z.object({
      serverId: serverIdField,
      name: z.string().min(1).describe("Exact prompt name on the server"),
      arguments: z
        .record(z.string())
        .optional()
        .describe("Prompt arguments (string values)"),
    }),
    execute: async ({ serverId, name, arguments: args }, { abortSignal }) =>
      runLiveOp(
        () => liveOps.getPrompt(serverId, name, args),
        abortSignal,
        "Rendering the prompt"
      ),
  });
}

function buildListResourcesTool(liveOps: McpjamLiveOps): ToolSet[string] {
  return tool({
    description:
      "List the resources an MCP server in this project exposes (uri, name, " +
      "mimeType).",
    inputSchema: z.object({ serverId: serverIdField, cursor: cursorField }),
    execute: async ({ serverId, cursor }, { abortSignal }) =>
      runLiveOp(
        () => liveOps.listResources(serverId, cursor),
        abortSignal,
        "Listing resources"
      ),
  });
}

function buildReadResourceTool(liveOps: McpjamLiveOps): ToolSet[string] {
  return tool({
    description:
      "Read a resource from an MCP server in this project by uri and return " +
      "its contents.",
    inputSchema: z.object({
      serverId: serverIdField,
      uri: z.string().min(1).describe("Resource uri from mcpjam_list_resources"),
    }),
    execute: async ({ serverId, uri }, { abortSignal }) =>
      runLiveOp(
        () => liveOps.readResource(serverId, uri),
        abortSignal,
        "Reading the resource"
      ),
  });
}

/**
 * Build one MCPJam tool by catalog id. Returns `null` when the id needs the
 * live-op runner and the surface didn't provide one — the registry logs and
 * skips, exactly like bash without a computer.
 */
export function buildMcpjamTool(
  id: McpjamToolId,
  opts: McpjamToolOptions
): ToolSet[string] | null {
  switch (id) {
    case MCPJAM_LIST_SERVERS_TOOL_NAME:
      return buildListServersTool(opts);
    case MCPJAM_LIST_EVAL_SUITES_TOOL_NAME:
      return buildListEvalSuitesTool(opts);
    case MCPJAM_DIAGNOSE_SERVER_TOOL_NAME:
      return opts.liveOps ? buildDiagnoseServerTool(opts.liveOps) : null;
    case MCPJAM_LIST_TOOLS_TOOL_NAME:
      return opts.liveOps ? buildListToolsTool(opts.liveOps) : null;
    case MCPJAM_CALL_TOOL_TOOL_NAME:
      return opts.liveOps ? buildCallToolTool(opts, opts.liveOps) : null;
    case MCPJAM_LIST_PROMPTS_TOOL_NAME:
      return opts.liveOps ? buildListPromptsTool(opts.liveOps) : null;
    case MCPJAM_GET_PROMPT_TOOL_NAME:
      return opts.liveOps ? buildGetPromptTool(opts.liveOps) : null;
    case MCPJAM_LIST_RESOURCES_TOOL_NAME:
      return opts.liveOps ? buildListResourcesTool(opts.liveOps) : null;
    case MCPJAM_READ_RESOURCE_TOOL_NAME:
      return opts.liveOps ? buildReadResourceTool(opts.liveOps) : null;
  }
}
