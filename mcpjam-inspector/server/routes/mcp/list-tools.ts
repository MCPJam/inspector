import { Hono } from "hono";
import "../../types/hono";
import { logger } from "../../utils/logger";
import {
  toServedFromCache,
  withCacheEventCapture,
} from "../../utils/cache-events.js";

const listTools = new Hono();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeToolMetadata(
  toolMeta: Record<string, unknown> | undefined,
  sidecarMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!toolMeta && !sidecarMeta) return undefined;

  const toolUi = toolMeta?.ui;
  const sidecarUi = sidecarMeta?.ui;
  return {
    ...(toolMeta ?? {}),
    ...(sidecarMeta ?? {}),
    ...(isRecord(toolUi) || isRecord(sidecarUi)
      ? {
          ui: {
            ...(isRecord(toolUi) ? toolUi : {}),
            ...(isRecord(sidecarUi) ? sidecarUi : {}),
          },
        }
      : {}),
  };
}

listTools.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { serverIds, refresh } = body as {
      serverIds?: unknown;
      refresh?: boolean;
    };

    if (!Array.isArray(serverIds) || serverIds.length === 0) {
      return c.json({ error: "serverIds must be a non-empty array" }, 400);
    }

    const clientManager = c.mcpClientManager;
    const allTools: Array<{
      name: string;
      description?: string;
      inputSchema?: any;
      serverId: string;
      // Carry `_meta` so clients can detect widget-rendering tools (the eval
      // editor uses it to surface per-widget interaction checks).
      _meta?: Record<string, unknown>;
    }> = [];

    const { events } = await withCacheEventCapture(async () => {
      for (const serverId of serverIds) {
        // Check if server is connected
        if (clientManager.getConnectionStatus(serverId) !== "connected") {
          continue;
        }

        try {
          const { tools } = await clientManager.listTools(
            serverId,
            undefined,
            { cacheMode: refresh ? "refresh" : undefined },
          );
          const toolsMetadata = clientManager.getAllToolsMetadata(serverId);
          const serverTools = tools.map((tool: any) => {
            const mergedMeta = mergeToolMetadata(
              tool._meta as Record<string, unknown> | undefined,
              toolsMetadata?.[tool.name] as
                | Record<string, unknown>
                | undefined,
            );
            return {
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              serverId,
              ...(mergedMeta ? { _meta: mergedMeta } : {}),
            };
          });
          allTools.push(...serverTools);
        } catch (error) {
          logger.warn(`Failed to list tools for server ${serverId}`, {
            serverId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    // Batch endpoint spans multiple servers — surface a single top-level
    // annotation when ANY server in the batch served from cache (per-tool
    // provenance isn't worth the shape churn for this aggregate response).
    const servedFromCache = toServedFromCache(events);
    return c.json({
      tools: allTools,
      ...(servedFromCache ? { servedFromCache } : {}),
    });
  } catch (error) {
    logger.error("Error in /list-tools", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default listTools;
