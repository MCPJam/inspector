/**
 * Shared chat-v2 tool preparation and message scrubbing.
 *
 * Encapsulates the identical prep logic used by both mcp/chat-v2 and web/chat-v2:
 *   1. getToolsForAiSdk + getSkillToolsAndPrompt + needsApproval merge
 *   2. Anthropic tool name validation (throws on invalid names)
 *   3. System prompt + skills prompt concatenation
 *   4. Temperature resolution (GPT-5 check)
 *   5. scrubMessages lambda construction
 *
 * Intentionally NOT shared:
 *   - Model type check (isMCPJamProvidedModel) — web rejects non-MCPJam; mcp supports user-provided
 *   - Error shape — web throws WebRouteError; mcp returns c.json()
 *   - Manager lifecycle — web has onStreamComplete cleanup; mcp uses singleton
 *   - streamText path — only in mcp
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ToolSet } from "ai";
import { MCPClientManager } from "@mcpjam/sdk";
import {
  isAnthropicCompatibleModel,
  getInvalidAnthropicToolNames,
  scrubMcpAppsToolResultsForBackend,
  scrubChatGPTAppsToolResultsForBackend,
  type CustomProviderConfig,
} from "./chat-helpers.js";
import { getSkillToolsAndPrompt } from "./skill-tools.js";
import { isGPT5Model, type ModelDefinition } from "@/shared/types";
import { HOSTED_MODE } from "../config.js";

const DEFAULT_TEMPERATURE = 0.7;

export interface PrepareChatV2Options {
  mcpClientManager: InstanceType<typeof MCPClientManager>;
  selectedServers?: string[];
  modelDefinition: ModelDefinition;
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  customProviders?: CustomProviderConfig[];
}

export interface PrepareChatV2Result {
  allTools: ToolSet;
  enhancedSystemPrompt: string;
  resolvedTemperature: number | undefined;
  scrubMessages: (msgs: ModelMessage[]) => ModelMessage[];
}

/**
 * Prepare tools, system prompt, temperature, and message scrubber for chat-v2.
 *
 * Throws if Anthropic tool name validation fails.
 */
export async function prepareChatV2(
  options: PrepareChatV2Options,
): Promise<PrepareChatV2Result> {
  const {
    mcpClientManager,
    selectedServers,
    modelDefinition,
    systemPrompt,
    temperature,
    requireToolApproval,
    customProviders,
  } = options;

  // 1. Get MCP + skill tools
  const mcpTools = await mcpClientManager.getToolsForAiSdk(
    selectedServers,
    requireToolApproval ? { needsApproval: requireToolApproval } : undefined,
  );
  const { tools: skillTools, systemPromptSection: skillsPromptSection } =
    HOSTED_MODE
      ? { tools: {}, systemPromptSection: "" }
      : await getSkillToolsAndPrompt();

  const finalSkillTools = requireToolApproval
    ? Object.fromEntries(
        Object.entries(skillTools).map(([name, tool]) => [
          name,
          { ...tool, needsApproval: true },
        ]),
      )
    : skillTools;

  const allTools = { ...mcpTools, ...finalSkillTools } as ToolSet;

  // 2. Anthropic tool name validation
  if (isAnthropicCompatibleModel(modelDefinition, customProviders)) {
    const invalidNames = getInvalidAnthropicToolNames(Object.keys(allTools));
    if (invalidNames.length > 0) {
      const nameList = invalidNames.map((name) => `'${name}'`).join(", ");
      throw new Error(
        `Invalid tool name(s) for Anthropic: ${nameList}. Tool names must only contain letters, numbers, underscores, and hyphens (max 64 characters).`,
      );
    }
  }

  // 3. System prompt concatenation
  const enhancedSystemPrompt = systemPrompt
    ? systemPrompt + skillsPromptSection
    : skillsPromptSection;

  // 4. Temperature resolution
  const resolvedTemperature = isGPT5Model(modelDefinition.id)
    ? undefined
    : (temperature ?? DEFAULT_TEMPERATURE);

  // 5. Message scrubber
  const scrubMessages = (msgs: ModelMessage[]) =>
    scrubChatGPTAppsToolResultsForBackend(
      scrubMcpAppsToolResultsForBackend(
        msgs,
        mcpClientManager,
        selectedServers,
      ),
      mcpClientManager,
      selectedServers,
    );

  return {
    allTools,
    enhancedSystemPrompt,
    resolvedTemperature,
    scrubMessages,
  };
}
