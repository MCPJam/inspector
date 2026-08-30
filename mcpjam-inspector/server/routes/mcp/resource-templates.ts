import { Hono } from "hono";
import "../../types/hono"; // Type extensions
import { reportRouteFailureForResponse } from "../../utils/route-error-report.js";
import {
  toServedFromCache,
  withCacheEventCapture,
} from "../../utils/cache-events.js";

const resourceTemplates = new Hono();

// List resource templates endpoint
resourceTemplates.post("/list", async (c) => {
  let serverId: string | undefined;
  try {
    const body = (await c.req.json()) as {
      serverId?: string;
      cursor?: string;
      refresh?: boolean;
    };
    serverId = body.serverId;
    const refresh = body.refresh;

    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const mcpClientManager = c.mcpClientManager;
    // Cursor is optional — omitted, this returns the full aggregate (the
    // official beta.4 client auto-pages no-cursor list calls). Passing a
    // cursor returns exactly one raw page, matching the tools/resources
    // routes' cursor parity.
    const { result, events } = await withCacheEventCapture(() =>
      mcpClientManager.listResourceTemplates(
        serverId!,
        // Presence, not truthiness: `""` is a valid continuation cursor.
        // The body is an untyped cast, so a non-string `cursor` is not a
        // cursor — omit it rather than forwarding it to the server.
        typeof body.cursor === "string" ? { cursor: body.cursor } : undefined,
        // Mirrors the SDK's `cacheOptions()` convention: omit the options
        // object entirely unless a refresh was actually requested.
        refresh === true ? { cacheMode: "refresh" as const } : undefined,
      ),
    );
    const servedFromCache = toServedFromCache(events);
    return c.json({
      resourceTemplates: result.resourceTemplates,
      // Relay the server's cursor verbatim. `""` is a valid continuation
      // cursor, so the test is presence — dropping it would turn "there is
      // another page" into "that was the last page" for the caller.
      ...(typeof result.nextCursor === "string"
        ? { nextCursor: result.nextCursor }
        : {}),
      ...(servedFromCache ? { servedFromCache } : {}),
    });
  } catch (error) {
    const { normalized, origin } = reportRouteFailureForResponse(
      "Error fetching resource templates",
      error,
      {
        source: "mcp.resource-templates.list",
        hop: "user_server_hop",
        context: { serverId },
      },
    );
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        normalized,
        origin,
      },
      500,
    );
  }
});

export default resourceTemplates;
