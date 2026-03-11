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
  includeMcpToolInventory?: boolean;
}

export interface PrepareChatV2Result {
  allTools: ToolSet;
  enhancedSystemPrompt: string;
  resolvedTemperature: number | undefined;
  scrubMessages: (msgs: ModelMessage[]) => ModelMessage[];
}

interface MCPToolPromptEntry {
  name: string;
  description?: string;
}

function truncateToolDescription(
  description: string | undefined,
  maxLength = 160,
): string | undefined {
  if (!description) return undefined;

  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildMcpToolInventoryPrompt(
  mcpTools: Record<string, unknown>,
  selectedServers?: string[],
): string {
  const serverGroups = new Map<string, MCPToolPromptEntry[]>();

  for (const [name, tool] of Object.entries(mcpTools)) {
    if (!tool || typeof tool !== "object") continue;

    const toolRecord = tool as Record<string, unknown>;
    const serverId =
      typeof toolRecord._serverId === "string"
        ? toolRecord._serverId
        : undefined;
    if (!serverId) continue;

    const existing = serverGroups.get(serverId) ?? [];
    existing.push({
      name,
      description:
        typeof toolRecord.description === "string"
          ? truncateToolDescription(toolRecord.description)
          : undefined,
    });
    serverGroups.set(serverId, existing);
  }

  if (serverGroups.size === 0) return "";

  const preferredServerIds = Array.from(new Set(selectedServers ?? [])).filter(
    (serverId) => serverGroups.has(serverId),
  );
  const remainingServerIds = Array.from(serverGroups.keys())
    .filter((serverId) => !preferredServerIds.includes(serverId))
    .sort((left, right) => left.localeCompare(right));
  const orderedServerIds = [...preferredServerIds, ...remainingServerIds];

  const serverSections = orderedServerIds
    .map((serverId) => {
      const toolLines = [...(serverGroups.get(serverId) ?? [])]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, description }) =>
          description ? `- ${name}: ${description}` : `- ${name}`,
        )
        .join("\n");

      return `Server ${serverId}:\n${toolLines}`;
    })
    .join("\n\n");

  return [
    "## Connected MCP Tools",
    "You have direct access to the following MCP tools. If the user asks what tools or servers are available, answer from this list instead of saying you do not have MCP visibility.",
    serverSections,
  ].join("\n\n");
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
    includeMcpToolInventory,
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
  const toolInventoryPromptSection = includeMcpToolInventory
    ? buildMcpToolInventoryPrompt(mcpTools, selectedServers)
    : "";

  const finalSkillTools: Record<string, unknown> = requireToolApproval
    ? Object.fromEntries(
        Object.entries(skillTools).map(([name, tool]) => [
          name,
          {
            ...(tool && typeof tool === "object" ? tool : {}),
            needsApproval: true,
          },
        ]),
      )
    : (skillTools as Record<string, unknown>);

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
  const enhancedSystemPrompt = [
    systemPrompt,
    toolInventoryPromptSection,
    skillsPromptSection,
  ]
    .filter((section): section is string => Boolean(section?.trim()))
    .join("\n\n");

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
