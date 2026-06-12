/**
 * MCPJam workspace built-in tools (`mcpjam_*`).
 *
 * First-class tools the chat agent uses to act on the MCPJam workspace
 * itself: list the project's saved servers, diagnose a connection, and run
 * live MCP operations (tools / prompts / resources) against ANY saved server
 * — not just the ones selected into the chat. Same shape pattern as
 * `exa-web-search.ts` / `bash.ts`: the inspector defines the tool;
 * authorization lives with the caller's bearer (Convex authorizes every
 * operation server-side, so a self-granted id confers nothing the bearer
 * couldn't already do via /api/v1).
 *
 * Two kinds of tool, split by what they need at build time:
 *   - `mcpjam_list_servers` — a plain Convex `/v1/project-servers` read with
 *     the caller's bearer (the `web_search` pattern). Needs no runner.
 *   - The seven live ops — they open an ephemeral authorize→connect→run
 *     pipeline, which is route-layer and context-bound. The route injects a
 *     `McpjamLiveOps` runner (see server/routes/web/mcpjam-live-ops.ts);
 *     `buildMcpjamTool` returns `null` for a live id without a runner, and
 *     the registry skips the tool — engines that can't run live ops simply
 *     never advertise them.
 *
 * Approval policy: every connection-opening op inherits the host's
 * `requireToolApproval`, mirroring the blanket approval MCP tools get from
 * the orchestration layer (the same operation called as an MCP tool would
 * show the approval pill, so the built-in must too). `mcpjam_list_servers`
 * is a pure Convex catalog read and never needs approval, like `web_search`.
 *
 * `execute` returns `{ error: string }` instead of throwing so the model can
 * relay problems conversationally instead of breaking the turn. Results are
 * capped before they reach model context (`MODEL_OUTPUT_CAP`).
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";

export const MCPJAM_TOOL_IDS = [
  "mcpjam_list_servers",
  "mcpjam_diagnose_server",
  "mcpjam_list_tools",
  "mcpjam_call_tool",
  "mcpjam_list_prompts",
  "mcpjam_get_prompt",
  "mcpjam_list_resources",
  "mcpjam_read_resource",
] as const;

export type McpjamToolId = (typeof MCPJAM_TOOL_IDS)[number];

export function isMcpjamToolId(id: string): id is McpjamToolId {
  return (MCPJAM_TOOL_IDS as readonly string[]).includes(id);
}

/**
 * Route-layer runner for the live MCP operations. Each method authorizes the
 * server against Convex, opens an ephemeral connection, runs the op, and
 * disconnects — and may throw (e.g. `WebRouteError`); the tool layer maps
 * throws to `{ error }`. The trailing `abortSignal` is advisory: the tool
 * layer pre-checks `aborted` before dispatching, and implementations may
 * ignore the signal (the ephemeral pipeline has no signal parameter today).
 */
export interface McpjamLiveOps {
  diagnoseServer(serverId: string, abortSignal?: AbortSignal): Promise<unknown>;
  listTools(
    serverId: string,
    cursor?: string,
    abortSignal?: AbortSignal
  ): Promise<unknown>;
  callTool(
    serverId: string,
    toolName: string,
    parameters: Record<string, unknown>,
    abortSignal?: AbortSignal
  ): Promise<unknown>;
  listPrompts(
    serverId: string,
    cursor?: string,
    abortSignal?: AbortSignal
  ): Promise<unknown>;
  getPrompt(
    serverId: string,
    promptName: string,
    args: Record<string, string | number | boolean> | undefined,
    abortSignal?: AbortSignal
  ): Promise<unknown>;
  listResources(
    serverId: string,
    cursor?: string,
    abortSignal?: AbortSignal
  ): Promise<unknown>;
  readResource(
    serverId: string,
    uri: string,
    abortSignal?: AbortSignal
  ): Promise<unknown>;
}

export interface McpjamToolOptions {
  /** Bearer authorization forwarded to Convex (already in scope). */
  authHeader: string;
  /** Project whose saved servers these tools operate on. */
  projectId: string;
  /** Live-op runner; absent on engines that can't open ephemeral connections. */
  liveOps?: McpjamLiveOps;
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

const serverIdField = z
  .string()
  .min(1)
  .describe("Saved server id, as returned by mcpjam_list_servers");

const cursorField = z
  .string()
  .optional()
  .describe("Opaque pagination cursor from a previous call's nextCursor");

function buildListServersTool(opts: McpjamToolOptions): ToolSet[string] {
  return tool({
    description:
      "List the MCP servers saved in this MCPJam project — every saved " +
      "server, not just the ones connected to this chat. Returns each " +
      "server's id, name, url, transport, enabled state, and whether it " +
      "uses OAuth. Call this first to get the server ids the other " +
      "mcpjam_* tools take.",
    inputSchema: z.object({}),
    execute: async (_input, { abortSignal }) => {
      const convexUrl = process.env.CONVEX_HTTP_URL;
      if (!convexUrl) {
        return { error: "MCPJam workspace tools are not configured." };
      }
      try {
        const target = new URL("/v1/project-servers", convexUrl);
        target.searchParams.set("projectId", opts.projectId);
        const res = await fetch(target, {
          headers: { Authorization: opts.authHeader },
          signal: abortSignal,
        });
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const upstream =
            body && typeof (body as { message?: unknown }).message === "string"
              ? (body as { message: string }).message
              : "";
          return {
            error: upstream || `Listing project servers failed (${res.status}).`,
          };
        }
        return capForModel(body);
      } catch (error) {
        if (abortSignal?.aborted) {
          return { error: "Listing project servers was cancelled." };
        }
        return toToolError(error, "Failed to list project servers.");
      }
    },
  });
}

/**
 * Shared wrapper for the seven live ops: abort pre-check → dispatch to the
 * runner → cap the result; throws become `{ error }`.
 */
function liveTool<Shape extends z.ZodRawShape>(cfg: {
  description: string;
  inputSchema: z.ZodObject<Shape>;
  needsApproval: boolean;
  cancelledMessage: string;
  failureMessage: string;
  run: (
    input: z.infer<z.ZodObject<Shape>>,
    abortSignal?: AbortSignal
  ) => Promise<unknown>;
}): ToolSet[string] {
  return tool({
    description: cfg.description,
    inputSchema: cfg.inputSchema,
    needsApproval: cfg.needsApproval,
    execute: async (input, { abortSignal }) => {
      if (abortSignal?.aborted) return { error: cfg.cancelledMessage };
      try {
        return capForModel(await cfg.run(input, abortSignal));
      } catch (error) {
        if (abortSignal?.aborted) return { error: cfg.cancelledMessage };
        return toToolError(error, cfg.failureMessage);
      }
    },
  });
}

/**
 * Build one `mcpjam_*` tool. Returns `null` when the id is a live op and no
 * runner was provided — the registry logs and skips, so the tool is simply
 * not advertised on that surface.
 */
export function buildMcpjamTool(
  id: McpjamToolId,
  opts: McpjamToolOptions
): ToolSet[string] | null {
  if (id === "mcpjam_list_servers") return buildListServersTool(opts);

  const liveOps = opts.liveOps;
  if (!liveOps) return null;
  const needsApproval = opts.requireToolApproval === true;

  switch (id) {
    case "mcpjam_diagnose_server":
      return liveTool({
        description:
          "Diagnose a saved MCP server's connection: probe the URL, " +
          "connect, initialize, and report capabilities and what failed. " +
          "Use when a server is erroring, won't connect, or the user asks " +
          "why a server isn't working.",
        inputSchema: z.object({ serverId: serverIdField }),
        needsApproval,
        cancelledMessage: "Server diagnosis was cancelled.",
        failureMessage: "Failed to diagnose the server.",
        run: ({ serverId }, signal) => liveOps.diagnoseServer(serverId, signal),
      });
    case "mcpjam_list_tools":
      return liveTool({
        description:
          "List the tools a saved MCP server exposes (name, description, " +
          "input schema). Works on any saved server, including ones not " +
          "connected to this chat. Use before mcpjam_call_tool to find the " +
          "tool name and required parameters.",
        inputSchema: z.object({ serverId: serverIdField, cursor: cursorField }),
        needsApproval,
        cancelledMessage: "Listing tools was cancelled.",
        failureMessage: "Failed to list the server's tools.",
        run: ({ serverId, cursor }, signal) =>
          liveOps.listTools(serverId, cursor, signal),
      });
    case "mcpjam_call_tool":
      return liveTool({
        description:
          "Execute a tool on a saved MCP server and return its result. " +
          "Works on any saved server, including ones not connected to this " +
          "chat. Get the tool name and parameter schema from " +
          "mcpjam_list_tools first. The call runs with the user's own " +
          "authorization and may have side effects.",
        inputSchema: z.object({
          serverId: serverIdField,
          toolName: z.string().min(1).describe("Exact tool name to execute"),
          parameters: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Tool arguments matching the tool's input schema"),
        }),
        needsApproval,
        cancelledMessage: "Tool execution was cancelled.",
        failureMessage: "Failed to execute the tool.",
        run: ({ serverId, toolName, parameters }, signal) =>
          liveOps.callTool(serverId, toolName, parameters ?? {}, signal),
      });
    case "mcpjam_list_prompts":
      return liveTool({
        description:
          "List the prompts a saved MCP server exposes (name, description, " +
          "arguments). Use before mcpjam_get_prompt to find the prompt name " +
          "and its arguments.",
        inputSchema: z.object({ serverId: serverIdField, cursor: cursorField }),
        needsApproval,
        cancelledMessage: "Listing prompts was cancelled.",
        failureMessage: "Failed to list the server's prompts.",
        run: ({ serverId, cursor }, signal) =>
          liveOps.listPrompts(serverId, cursor, signal),
      });
    case "mcpjam_get_prompt":
      return liveTool({
        description:
          "Render a prompt from a saved MCP server with the given arguments " +
          "and return its messages. Get the prompt name and argument list " +
          "from mcpjam_list_prompts first.",
        inputSchema: z.object({
          serverId: serverIdField,
          promptName: z.string().min(1).describe("Exact prompt name"),
          arguments: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .optional()
            .describe("Prompt arguments, if the prompt declares any"),
        }),
        needsApproval,
        cancelledMessage: "Getting the prompt was cancelled.",
        failureMessage: "Failed to get the prompt.",
        run: ({ serverId, promptName, arguments: args }, signal) =>
          liveOps.getPrompt(serverId, promptName, args, signal),
      });
    case "mcpjam_list_resources":
      return liveTool({
        description:
          "List the resources a saved MCP server exposes (uri, name, " +
          "mimeType). Use before mcpjam_read_resource to find the resource " +
          "uri.",
        inputSchema: z.object({ serverId: serverIdField, cursor: cursorField }),
        needsApproval,
        cancelledMessage: "Listing resources was cancelled.",
        failureMessage: "Failed to list the server's resources.",
        run: ({ serverId, cursor }, signal) =>
          liveOps.listResources(serverId, cursor, signal),
      });
    case "mcpjam_read_resource":
      return liveTool({
        description:
          "Read one resource from a saved MCP server by uri and return its " +
          "contents. Get the uri from mcpjam_list_resources first.",
        inputSchema: z.object({
          serverId: serverIdField,
          uri: z.string().min(1).describe("Exact resource uri to read"),
        }),
        needsApproval,
        cancelledMessage: "Reading the resource was cancelled.",
        failureMessage: "Failed to read the resource.",
        run: ({ serverId, uri }, signal) =>
          liveOps.readResource(serverId, uri, signal),
      });
  }
}
