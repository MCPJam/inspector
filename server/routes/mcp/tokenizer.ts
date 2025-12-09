import { Hono } from "hono";
import "../../types/hono";
import {
  mapModelIdToTokenizerBackend,
  estimateTokensFromChars,
} from "../../utils/tokenizer-helpers";

const tokenizer = new Hono();

/**
 * Proxy endpoint to count tokens for MCP server tools
 * POST /api/mcp/tokenizer/count-tools
 * Body: { selectedServers: string[], modelId: string }
 */
tokenizer.post("/count-tools", async (c) => {
  try {
    const body = (await c.req.json()) as {
      selectedServers?: string[];
      modelId?: string;
    };

    const { selectedServers, modelId } = body;

    if (!Array.isArray(selectedServers)) {
      return c.json(
        {
          ok: false,
          error: "selectedServers must be an array",
        },
        400,
      );
    }

    if (!modelId || typeof modelId !== "string") {
      return c.json(
        {
          ok: false,
          error: "modelId is required",
        },
        400,
      );
    }

    // If no servers selected, return empty object
    if (selectedServers.length === 0) {
      return c.json({
        ok: true,
        tokenCounts: {},
      });
    }

    const mcpClientManager = c.mcpClientManager;

    const convexHttpUrl = process.env.CONVEX_HTTP_URL;
    if (!convexHttpUrl) {
      return c.json(
        {
          ok: false,
          error: "Server missing CONVEX_HTTP_URL configuration",
        },
        500,
      );
    }

    // Get token counts for each server individually
    const tokenCounts: Record<string, number> = {};

    // Map model ID to backend-recognized format
    const mappedModelId = mapModelIdToTokenizerBackend(modelId);
    const useBackendTokenizer = mappedModelId !== null;

    await Promise.all(
      selectedServers.map(async (serverId) => {
        try {
          // Get tools JSON for this specific server
          const tools = await mcpClientManager.getToolsForAiSdk([serverId]);

          // Serialize tools JSON to string for tokenization
          const toolsText = JSON.stringify(tools);

          if (useBackendTokenizer && mappedModelId) {
            // Use backend tokenizer API for mapped models
            const response = await fetch(`${convexHttpUrl}/tokenizer/count`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                text: toolsText,
                model: mappedModelId,
              }),
            });

            if (response.ok) {
              const data = (await response.json()) as {
                ok?: boolean;
                tokenCount?: number;
                error?: string;
              };
              if (data.ok) {
                tokenCounts[serverId] = data.tokenCount || 0;
              } else {
                console.warn(
                  `[tokenizer] Failed to count tokens for server ${serverId}:`,
                  data.error,
                );
                // Fallback to character-based estimation on backend error
                tokenCounts[serverId] = estimateTokensFromChars(toolsText);
              }
            } else {
              console.warn(
                `[tokenizer] Failed to count tokens for server ${serverId}:`,
                response.status,
              );
              // Fallback to character-based estimation on HTTP error
              tokenCounts[serverId] = estimateTokensFromChars(toolsText);
            }
          } else {
            // Use character-based fallback for unmapped models
            tokenCounts[serverId] = estimateTokensFromChars(toolsText);
          }
        } catch (error) {
          console.warn(
            `[tokenizer] Error counting tokens for server ${serverId}:`,
            error,
          );
          // Fallback to character-based estimation on error
          try {
            const tools = await mcpClientManager.getToolsForAiSdk([serverId]);
            const toolsText = JSON.stringify(tools);
            tokenCounts[serverId] = estimateTokensFromChars(toolsText);
          } catch {
            tokenCounts[serverId] = 0;
          }
        }
      }),
    );

    return c.json({
      ok: true,
      tokenCounts,
    });
  } catch (error) {
    console.error("[tokenizer] Error counting MCP tools tokens:", error);
    return c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/**
 * Proxy endpoint to count tokens for arbitrary text
 * POST /api/mcp/tokenizer/count-text
 * Body: { text: string, modelId: string }
 */
tokenizer.post("/count-text", async (c) => {
  try {
    const body = (await c.req.json()) as {
      text?: string;
      modelId?: string;
    };

    const { text, modelId } = body;

    if (!text || typeof text !== "string") {
      return c.json(
        {
          ok: false,
          error: "text is required and must be a string",
        },
        400,
      );
    }

    if (!modelId || typeof modelId !== "string") {
      return c.json(
        {
          ok: false,
          error: "modelId is required",
        },
        400,
      );
    }

    const convexHttpUrl = process.env.CONVEX_HTTP_URL;
    if (!convexHttpUrl) {
      return c.json(
        {
          ok: false,
          error: "Server missing CONVEX_HTTP_URL configuration",
        },
        500,
      );
    }

    const mappedModelId = mapModelIdToTokenizerBackend(modelId);
    const useBackendTokenizer = mappedModelId !== null;

    if (useBackendTokenizer && mappedModelId) {
      try {
        // Use backend tokenizer API for mapped models
        const response = await fetch(`${convexHttpUrl}/tokenizer/count`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text,
            model: mappedModelId,
          }),
        });

        if (response.ok) {
          const data = (await response.json()) as {
            ok?: boolean;
            tokenCount?: number;
            error?: string;
          };
          if (data.ok) {
            return c.json({
              ok: true,
              tokenCount: data.tokenCount || 0,
            });
          } else {
            console.warn(
              `[tokenizer] Failed to count tokens for text:`,
              data.error,
            );
            // Fallback to character-based estimation on backend error
            return c.json({
              ok: true,
              tokenCount: estimateTokensFromChars(text),
            });
          }
        } else {
          console.warn(
            `[tokenizer] Failed to count tokens for text:`,
            response.status,
          );
          // Fallback to character-based estimation on HTTP error
          return c.json({
            ok: true,
            tokenCount: estimateTokensFromChars(text),
          });
        }
      } catch (error) {
        console.warn(`[tokenizer] Error counting tokens for text:`, error);
        // Fallback to character-based estimation on error
        return c.json({
          ok: true,
          tokenCount: estimateTokensFromChars(text),
        });
      }
    } else {
      // Use character-based fallback for unmapped models
      return c.json({
        ok: true,
        tokenCount: estimateTokensFromChars(text),
      });
    }
  } catch (error) {
    console.error("[tokenizer] Error counting text tokens:", error);
    return c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default tokenizer;
