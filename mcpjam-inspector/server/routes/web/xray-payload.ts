/**
 * X-Ray Payload Endpoint (Hosted Mode)
 *
 * Returns the actual payload that would be sent to the AI model,
 * including the enhanced system prompt and all tools (MCP + skill tools).
 *
 * Hosted-mode counterpart to routes/mcp/xray-payload.ts — uses ephemeral
 * per-request connections authorised via Convex instead of the persistent
 * singleton MCPClientManager.
 */

import { Hono } from "hono";
import { z } from "zod";
import { getSkillToolsAndPrompt } from "../../utils/skill-tools.js";
import {
  hostedChatSchema,
  createAuthorizedManager,
  assertBearerToken,
  readJsonBody,
  parseWithSchema,
  handleRoute,
  withManager,
} from "./auth.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";

const xrayPayloadSchema = hostedChatSchema.extend({
  messages: z.array(z.unknown()).default([]),
  systemPrompt: z.string().optional(),
});

interface SerializedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const xrayPayload = new Hono();

xrayPayload.post("/", async (c) => {
  return handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(
      xrayPayloadSchema,
      await readJsonBody<unknown>(c),
    );

    const { messages, systemPrompt, selectedServerIds } = body;

    return withManager(
      createAuthorizedManager(
        bearerToken,
        body.workspaceId,
        selectedServerIds,
        WEB_CALL_TIMEOUT_MS,
        body.oauthTokens,
      ),
      async (manager) => {
        // Get MCP tools from selected servers
        const mcpTools = await manager.getToolsForAiSdk(selectedServerIds);

        // Get skill tools and system prompt section
        // (returns empty in hosted mode since no local filesystem — that's expected)
        const {
          tools: skillTools,
          systemPromptSection: skillsPromptSection,
        } = await getSkillToolsAndPrompt();

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
          const schema =
            (tool as any).parameters ?? (tool as any).inputSchema;

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
                serializedSchema = z.toJSONSchema(schema) as Record<
                  string,
                  unknown
                >;
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
      },
    );
  });
});

export default xrayPayload;
