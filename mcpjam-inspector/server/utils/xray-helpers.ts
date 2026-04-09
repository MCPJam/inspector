/**
 * Shared X-Ray payload helpers used by both local and hosted xray-payload routes.
 */

import { z } from "zod";
import type { MCPClientManager } from "@mcpjam/sdk";
import { getSkillToolsAndPrompt } from "./skill-tools.js";
import { buildMcpToolInventoryPrompt } from "./chat-v2-orchestration.js";

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
  options?: {
    includeSkills?: boolean;
    includeMcpToolInventory?: boolean;
  },
): Promise<XRayPayloadResponse> {
  const includeSkills = options?.includeSkills ?? true;
  const includeMcpToolInventory = options?.includeMcpToolInventory ?? false;

  // Get MCP tools from selected servers
  const mcpTools = await manager.getToolsForAiSdk(serverIds);

  // Get skill tools and system prompt section
  const { tools: skillTools, systemPromptSection: skillsPromptSection } =
    includeSkills
      ? await getSkillToolsAndPrompt()
      : { tools: {}, systemPromptSection: "" };
  const toolInventoryPromptSection = includeMcpToolInventory
    ? buildMcpToolInventoryPrompt(mcpTools, serverIds)
    : "";

  // Merge MCP tools with skill tools (same as chat-v2.ts)
  const allTools = { ...mcpTools, ...skillTools };

  // Build enhanced system prompt
  const enhancedSystemPrompt = [
    systemPrompt,
    toolInventoryPromptSection,
    skillsPromptSection,
  ]
    .filter((section): section is string => Boolean(section?.trim()))
    .map((section) => section.trim())
    .join("\n\n");

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
    messages,
  };
}
