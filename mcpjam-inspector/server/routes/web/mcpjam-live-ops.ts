/**
 * Route-layer factory for the `mcpjam_*` live-op runner.
 *
 * Lives in routes/web on purpose: the authorize→connect→run pipeline
 * (`runEphemeralConnection`, `runHostedDoctor`) is context-bound — it reads
 * the caller's bearer off the Hono context and resolves OAuth tokens via the
 * Convex authorize step. Each method opens an ephemeral connection for one
 * operation and tears it down in `finally`, exactly like the public
 * `/api/v1` adapters (`server/routes/v1/*` call these same cores via
 * `runV1ServerOp`) — no forked handler logic.
 *
 * The closures only READ from `c` (headers, request-scoped vars), which is
 * safe after the chat route has returned its streaming Response — the same
 * assumption `onStreamComplete` already relies on.
 *
 * The `McpjamLiveOps` trailing abortSignal is accepted but unused here:
 * `runEphemeralConnection` has no signal parameter today, and the tool layer
 * pre-checks `aborted` before dispatching. Threading the signal into the
 * manager/timeout layer is optional hardening.
 *
 * Bodies synthesized here never set `taskOptions` (the hosted task
 * restriction the v1 surface enforces) and never carry chatbox identity —
 * authorization is project membership, which is why the registry doesn't
 * advertise these tools in chatbox sessions.
 */
import type { Context } from "hono";
import {
  runEphemeralConnection,
  toolsListSchema,
  toolsExecuteSchema,
  promptsListSchema,
  promptsGetSchema,
  resourcesListSchema,
  resourcesReadSchema,
} from "./auth.js";
import { runHostedDoctor } from "./servers.js";
import {
  listTools,
  listPrompts,
  getPrompt,
  listResources,
  readResource,
} from "../../utils/route-handlers.js";
import { WEB_CONNECT_TIMEOUT_MS } from "../../config.js";
import type { McpjamLiveOps } from "../../utils/built-in-tools/mcpjam.js";

export function buildMcpjamLiveOps(
  c: Context,
  projectId: string
): McpjamLiveOps {
  return {
    diagnoseServer: (serverId) =>
      runHostedDoctor(c, { projectId, serverId }, WEB_CONNECT_TIMEOUT_MS),

    listTools: (serverId, cursor) =>
      runEphemeralConnection(
        c,
        { projectId, serverId, ...(cursor ? { cursor } : {}) },
        toolsListSchema,
        async (manager, body) => {
          // Project to the wire result: the inspector-only toolsMetadata /
          // tokenCount enrichments are dropped before model context, the
          // same boundary decision /api/v1 makes.
          const { tools, nextCursor } = await listTools(manager, body);
          return { tools, ...(nextCursor ? { nextCursor } : {}) };
        }
      ),

    callTool: (serverId, toolName, parameters) =>
      runEphemeralConnection(
        c,
        { projectId, serverId, toolName, parameters },
        toolsExecuteSchema,
        (manager, body) =>
          manager.executeTool(body.serverId, body.toolName, body.parameters)
      ),

    listPrompts: (serverId, cursor) =>
      runEphemeralConnection(
        c,
        { projectId, serverId, ...(cursor ? { cursor } : {}) },
        promptsListSchema,
        (manager, body) => listPrompts(manager, body)
      ),

    getPrompt: (serverId, promptName, args) =>
      runEphemeralConnection(
        c,
        {
          projectId,
          serverId,
          promptName,
          ...(args ? { arguments: args } : {}),
        },
        promptsGetSchema,
        (manager, body) =>
          getPrompt(manager, {
            serverId: body.serverId,
            name: body.promptName,
            arguments: body.arguments,
          })
      ),

    listResources: (serverId, cursor) =>
      runEphemeralConnection(
        c,
        { projectId, serverId, ...(cursor ? { cursor } : {}) },
        resourcesListSchema,
        (manager, body) => listResources(manager, body)
      ),

    readResource: (serverId, uri) =>
      runEphemeralConnection(
        c,
        { projectId, serverId, uri },
        resourcesReadSchema,
        (manager, body) => readResource(manager, body)
      ),
  };
}
