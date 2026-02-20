/**
 * Shared X-Ray payload helpers used by both local and hosted xray-payload routes.
 */

import { z } from "zod";
import type { MCPClientManager } from "@mcpjam/sdk";
import { getSkillToolsAndPrompt } from "./skill-tools.js";

export interface SerializedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface XRayPayloadResponse {
  system: string;
  tools: Record<string, SerializedTool>;
  messages: unknown[];
}

/**
 * Build the X-Ray payload: fetches tools from connected MCP servers,
 * merges with skill tools, serializes schemas, and assembles the response.
 */
export async function buildXRayPayload(
  manager: MCPClientManager,
  serverIds: string[],
  messages: unknown[],
  systemPrompt?: string,
): Promise<XRayPayloadResponse> {
  // Get MCP tools from selected servers
  const mcpTools = await manager.getToolsForAiSdk(serverIds);

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
          serializedSchema = z.toJSONSchema(schema) as Record<string, unknown>;
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

  return {
    system: enhancedSystemPrompt,
    tools: serializedTools,
    messages: messages ?? [],
  };
}
