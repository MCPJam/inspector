/**
 * X-Ray Payload Endpoint
 *
 * Returns the actual payload that would be sent to the AI model,
 * including the enhanced system prompt and all tools (MCP + skill tools).
 */

import { Hono } from "hono";
import type { UIMessage } from "ai";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { getSkillToolsAndPrompt } from "../../utils/skill-tools";

interface XRayPayloadRequest {
  messages: UIMessage[];
  systemPrompt?: string;
  selectedServers?: string[];
}

interface SerializedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface XRayPayloadResponse {
  system: string;
  tools: Record<string, SerializedTool>;
  messages: unknown[]; // Raw messages with metadata (token counts, etc.)
}

const xrayPayload = new Hono();

xrayPayload.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as XRayPayloadRequest;
    const mcpClientManager = c.mcpClientManager;
    const { messages, systemPrompt, selectedServers } = body;

    // Get MCP tools from selected servers
    const mcpTools = await mcpClientManager.getToolsForAiSdk(
      selectedServers ?? [],
    );

    // Get skill tools and system prompt section
    const { tools: skillTools, systemPromptSection: skillsPromptSection } =
      await getSkillToolsAndPrompt();

    // Merge MCP tools with skill tools (same as chat-v2.ts)
    const allTools = { ...mcpTools, ...skillTools };

    // Build enhanced system prompt (same as chat-v2.ts)
    const enhancedSystemPrompt = systemPrompt
      ? systemPrompt + skillsPromptSection
      : skillsPromptSection;

    // Serialize tools to JSON-compatible format
    const serializedTools: Record<string, SerializedTool> = {};
    for (const [name, tool] of Object.entries(allTools)) {
      if (!tool) continue;

      let serializedSchema: Record<string, unknown> | undefined;
      // AI SDK tools use 'parameters' (Zod schema), MCP tools use 'inputSchema' (JSON Schema)
      const schema = (tool as any).parameters ?? (tool as any).inputSchema;

      if (schema) {
        if (
          typeof schema === "object" &&
          schema !== null &&
          "jsonSchema" in (schema as Record<string, unknown>)
        ) {
          serializedSchema = (schema as any).jsonSchema as Record<
            string,
            unknown
          >;
        } else {
          try {
            // Zod v4 introduced a built-in toJSONSchema() method on the z namespace,
            // while Zod v3 requires the external zod-to-json-schema library.
            const toJSONSchema = (z as any).toJSONSchema;
            if (typeof toJSONSchema === "function") {
              serializedSchema = toJSONSchema(schema) as Record<
                string,
                unknown
              >;
            } else {
              // Fall back to zod-to-json-schema for Zod v3
              serializedSchema = zodToJsonSchema(schema) as Record<
                string,
                unknown
              >;
            }
          } catch {
            serializedSchema = {
              type: "object",
              properties: {},
              additionalProperties: false,
            };
          }
        }
      }

      serializedTools[name] = {
        name,
        description: (tool as any).description,
        inputSchema:
          serializedSchema ??
          ({
            type: "object",
            properties: {},
            additionalProperties: false,
          } as any),
      };
    }

    // Return raw messages with metadata (includes token counts from responses)
    // Note: The actual chat-v2.ts uses convertToModelMessages() before sending to the model,
    // but we preserve the raw format here to show token usage metadata
    const response: XRayPayloadResponse = {
      system: enhancedSystemPrompt,
      tools: serializedTools,
      messages: messages ?? [],
    };

    return c.json(response);
  } catch (error) {
    console.error("[mcp/xray-payload] failed to build payload", error);
    return c.json({ error: "Failed to build X-Ray payload" }, 500);
  }
});

export default xrayPayload;
