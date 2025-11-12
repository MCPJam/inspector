import { Hono } from "hono";
import "../../types/hono";

const tokenizer = new Hono();

/**
 * Mapping from application model IDs to tokenizer backend model IDs.
 * This includes:
 * - Model enum values (e.g., "gpt-5" → "openai/gpt-5")
 * - MCPJam provided models (e.g., "meta-llama/llama-3.3-70b-instruct" → "meta/llama-3.3-70b")
 * - Provider-prefixed models that need normalization
 */
const MODEL_ID_MAPPING = new Map<string, string>([
  // Anthropic models
  ["claude-opus-4-0", "anthropic/claude-opus-4"],
  ["claude-sonnet-4-0", "anthropic/claude-sonnet-4"],
  ["claude-3-7-sonnet-latest", "anthropic/claude-3.7-sonnet"],
  ["claude-3-5-sonnet-latest", "anthropic/claude-3.5-sonnet"],
  ["claude-3-5-haiku-latest", "anthropic/claude-3.5-haiku"],
  ["anthropic/claude-sonnet-4.5", "anthropic/claude-sonnet-4.5"],
  ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5"], // Fallback to sonnet-4.5 if haiku-4.5 not available

  // OpenAI models
  ["gpt-5", "openai/gpt-5"],
  ["gpt-5-mini", "openai/gpt-5-mini"],
  ["gpt-5-nano", "openai/gpt-5-nano"],
  ["gpt-5-pro", "openai/gpt-5-pro"],
  ["gpt-5-codex", "openai/gpt-5-codex"],
  ["openai/gpt-5", "openai/gpt-5"],
  ["openai/gpt-5-mini", "openai/gpt-5-mini"],
  ["openai/gpt-5-nano", "openai/gpt-5-nano"],
  ["openai/gpt-5-codex", "openai/gpt-5-codex"],
  ["gpt-4.1", "openai/gpt-4.1"],
  ["gpt-4.1-mini", "openai/gpt-4.1-mini"],
  ["gpt-4.1-nano", "openai/gpt-4.1-nano"],
  ["openai/gpt-4.1", "openai/gpt-4.1"],
  ["openai/gpt-4.1-mini", "openai/gpt-4.1-mini"],
  ["gpt-4o", "openai/gpt-4o"],
  ["gpt-4o-mini", "openai/gpt-4o-mini"],
  ["openai/gpt-4o", "openai/gpt-4o"],
  ["openai/gpt-4o-mini", "openai/gpt-4o-mini"],
  ["gpt-4-turbo", "openai/gpt-4-turbo"],
  ["openai/gpt-4-turbo", "openai/gpt-4-turbo"],
  ["gpt-4", "openai/gpt-4-turbo"], // Fallback to turbo
  ["openai/gpt-oss-120b", "openai/gpt-oss-120b"],

  // Google Gemini models
  ["gemini-2.5-pro", "google/gemini-2.5-pro"],
  ["google/gemini-2.5-pro", "google/gemini-2.5-pro"],
  ["gemini-2.5-flash", "google/gemini-2.5-flash"],
  ["google/gemini-2.5-flash", "google/gemini-2.5-flash"],
  [
    "google/gemini-2.5-flash-preview-09-2025",
    "google/gemini-2.5-flash-preview-09-2025",
  ],
  ["gemini-2.5-flash-lite", "google/gemini-2.5-flash-lite"],
  ["google/gemini-2.5-flash-lite", "google/gemini-2.5-flash-lite"],
  ["gemini-2.0-flash-exp", "google/gemini-2.0-flash"],
  ["gemini-1.5-pro-002", "google/gemini-2.5-pro"], // Fallback to 2.5-pro
  ["gemini-1.5-pro", "google/gemini-2.5-pro"], // Fallback to 2.5-pro
  ["gemini-1.5-flash-002", "google/gemini-2.5-flash"], // Fallback to 2.5-flash
  ["gemini-1.5-flash", "google/gemini-2.5-flash"], // Fallback to 2.5-flash

  // Meta models
  ["meta-llama/llama-3.3-70b-instruct", "meta/llama-3.3-70b"],

  // DeepSeek models
  ["deepseek-chat", "deepseek/deepseek-v3.1"],
  ["deepseek-reasoner", "deepseek/deepseek-r1"],

  // Mistral models
  ["mistral-large-latest", "mistral/mistral-large"],
  ["mistral-small-latest", "mistral/mistral-small"],
  ["codestral-latest", "mistral/codestral"],
  ["ministral-8b-latest", "mistral/mistral-small"], // Fallback
  ["ministral-3b-latest", "mistral/mistral-small"], // Fallback

  // xAI models
  ["grok-3", "xai/grok-3"],
  ["grok-3-mini", "xai/grok-3-mini"],
  ["grok-code-fast-1", "xai/grok-code-fast-1"],
  ["grok-4-fast-non-reasoning", "xai/grok-4-fast-non-reasoning"],
  ["grok-4-fast-reasoning", "xai/grok-4-fast-reasoning"],
  ["x-ai/grok-4-fast", "xai/grok-4-fast-reasoning"], // Map to reasoning version

  // MoonshotAI models
  ["moonshotai/kimi-k2-0905", "moonshotai/kimi-k2-0905"],

  // Z-AI models
  ["z-ai/glm-4.6", "zai/glm-4.5"], // Map to closest available version
]);

/**
 * Maps application model IDs to tokenizer backend model IDs.
 * Maps to model IDs recognized by the ai-tokenizer backend.
 * Returns null if no mapping exists (should use character-based fallback).
 */
function mapModelIdToTokenizerBackend(modelId: string): string | null {
  return MODEL_ID_MAPPING.get(modelId) || null;
}

/**
 * Character-based token estimation fallback: 1 token ≈ 4 characters
 */
function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 4);
}

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
