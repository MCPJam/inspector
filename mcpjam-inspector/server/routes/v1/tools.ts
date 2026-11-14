import { Hono } from "hono";
import { toolsExecuteSchema, toolsListSchema } from "../web/auth.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { listTools } from "../../utils/route-handlers.js";
import { runV1ServerOp } from "./adapter.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import {
  connectionEffectiveAuth,
  toolResultAuthChallengeEnvelope,
} from "../../utils/connection-effective-auth.js";
import { projectAuthChallenge } from "../../utils/hosted-upstream-projection.js";

const tools = new Hono();

// POST /v1/projects/:projectId/servers/:serverId/tools
// List the server's tools. Wraps the same listTools core as /api/web/tools/list,
// projecting the MCP result into the canonical { items, nextCursor? } page.
// (The inspector-only toolsMetadata/tokenCount enrichments are intentionally
// dropped at the public boundary.)
tools.post("/projects/:projectId/servers/:serverId/tools", async (c) =>
  runV1ServerOp(
    c,
    toolsListSchema,
    (manager, body) => listTools(manager, body),
    (ctx, result: { tools?: unknown[]; nextCursor?: string }) =>
      v1PageJson(ctx, result.tools ?? [], result.nextCursor)
  )
);

// POST /v1/projects/:projectId/servers/:serverId/tools/call
// Execute a tool and return the MCP CallToolResult plus additive durationMs.
// Tool-level failures (result.isError === true) are successful calls — the
// server answered; only transport/auth errors flow through the v1 error
// envelope. Mirrors /api/web/tools/execute, including the hosted task
// restriction.
tools.post("/projects/:projectId/servers/:serverId/tools/call", async (c) =>
  runV1ServerOp(
    c,
    toolsExecuteSchema,
    async (manager, body) => {
      // Both task opt-ins are refused here: the public API contract is a
      // separate decision from the hosted UI's, so /api/v1 stays task-free
      // even though hosted /web now allows them.
      if (body.taskOptions || body.allowTaskResult) {
        throw new WebRouteError(
          400,
          ErrorCode.FEATURE_NOT_SUPPORTED,
          "Task-augmented tool execution is not supported on /api/v1"
        );
      }
      const startedAt = Date.now();
      const result = await manager.executeTool(
        body.serverId,
        body.toolName,
        body.parameters
      );
      const durationMs = Math.max(0, Date.now() - startedAt);
      // Additive sibling on the MCP CallToolResult. `v1Resource` returns the
      // object verbatim, so agents can read latency without a second hop.
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const record = result as Record<string, unknown>;
        // A ChatGPT-style sign-in challenge (`_meta["mcp/www_authenticate"]`
        // on an `isError` result), parsed and stamped with the connection's
        // effective auth method, reduced like every relayed answer. Additive,
        // and never shadowing a server field of the same name.
        const authChallenge = projectAuthChallenge(
          toolResultAuthChallengeEnvelope(
            result,
            connectionEffectiveAuth(manager, body.serverId)
          )
        );
        // Never shadow the server's own field. `CallToolResult` allows extra
        // keys, so a server may already report a `durationMs` of its own —
        // overwriting it would destroy upstream data to report our copy of
        // roughly the same number.
        return {
          ...record,
          ...("durationMs" in record ? {} : { durationMs }),
          ...(authChallenge && !("authChallenge" in record)
            ? { authChallenge }
            : {}),
        };
      }
      return result;
    },
    (ctx, result) => v1Resource(ctx, result)
  )
);

export default tools;
