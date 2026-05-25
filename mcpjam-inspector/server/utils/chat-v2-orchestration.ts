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
  scrubUnavailableToolHistoryForBackend,
  scrubMcpAppsToolResultsForBackend,
  scrubChatGPTAppsToolResultsForBackend,
  type CustomProviderConfig,
} from "./chat-helpers.js";
import { getSkillToolsAndPrompt } from "./skill-tools.js";
import { isGPT5Model, type ModelDefinition } from "@/shared/types";
import { HOSTED_MODE } from "../config.js";

const DEFAULT_TEMPERATURE = 0.7;

/**
 * SEP-1865: "Host MUST NOT include tools in the agent's tool list when
 * their visibility does not include 'model'." Hide when `visibility` is
 * an array that doesn't contain "model" — covers `["app"]`, `[]`, and
 * any future scope literal that isn't "model".
 *
 * Missing `visibility` (or non-array) defaults to both per the spec, so
 * the tool stays visible. We can't use the upstream
 * `isToolVisibilityAppOnly` helper for this — it only matches exactly
 * `["app"]` and would leak the `[]` and future-scope cases through.
 */
function shouldHideFromModel(
  meta: Record<string, unknown> | undefined,
): boolean {
  const ui = meta?.ui as { visibility?: unknown } | undefined;
  const visibility = ui?.visibility;
  if (!Array.isArray(visibility)) return false;
  return !visibility.includes("model");
}

/**
 * Mutates `tools` in place, removing entries whose source MCP tool
 * declares a SEP-1865 `_meta.ui.visibility` that does not include
 * `"model"`. Tools remain callable from the iframe bridge.
 */
function filterAppOnlyTools(
  tools: ToolSet,
  manager: InstanceType<typeof MCPClientManager>,
): void {
  // Cache per-server metadata maps so we don't repeatedly clone them.
  const metaByServer = new Map<string, Record<string, Record<string, any>>>();
  const getMeta = (serverId: string) => {
    let cached = metaByServer.get(serverId);
    if (!cached) {
      cached = manager.getAllToolsMetadata(serverId);
      metaByServer.set(serverId, cached);
    }
    return cached;
  };

  for (const [name, tool] of Object.entries(tools)) {
    const serverId = (tool as { _serverId?: unknown })._serverId;
    if (typeof serverId !== "string") continue;
    const meta = getMeta(serverId)[name];
    if (shouldHideFromModel(meta)) {
      delete tools[name];
    }
  }
}

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

  // Drop ids the manager hasn't registered (server disabled/disconnected, or
  // a stale id baked into a chatbox config). Passing them through reaches
  // ensureConnected and throws "Unknown MCP server", 500-ing the whole chat.
  const knownSelectedServers = selectedServers?.filter((id) =>
    mcpClientManager.hasServer(id),
  );

  // 1. Get MCP + skill tools
  const mcpTools = await mcpClientManager.getToolsForAiSdk(
    knownSelectedServers,
    requireToolApproval ? { needsApproval: requireToolApproval } : undefined,
  );

  // SEP-1865: tools whose `_meta.ui.visibility` is exactly `["app"]` are
  // hidden from the model — they remain callable from the iframe via the
  // bridge but must not appear in the AI SDK tool set. The conversion
  // helper doesn't lift `_meta` onto the AiSdkTool, so we look the
  // metadata back up per (serverId, toolName) from the manager's cache.
  filterAppOnlyTools(mcpTools, mcpClientManager);
  const { tools: skillTools, systemPromptSection: skillsPromptSection } =
    HOSTED_MODE
      ? { tools: {}, systemPromptSection: "" }
      : await getSkillToolsAndPrompt();

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
  const availableToolNames = Object.keys(allTools);

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
  const enhancedSystemPrompt = [systemPrompt, skillsPromptSection]
    .filter((section): section is string => Boolean(section?.trim()))
    .map((section) => section.trim())
    .join("\n\n");

  // 4. Temperature resolution
  const resolvedTemperature = isGPT5Model(modelDefinition.id)
    ? undefined
    : (temperature ?? DEFAULT_TEMPERATURE);

  // 5. Message scrubber
  const scrubMessages = (msgs: ModelMessage[]) =>
    scrubChatGPTAppsToolResultsForBackend(
      scrubMcpAppsToolResultsForBackend(
        scrubUnavailableToolHistoryForBackend(msgs, availableToolNames),
        mcpClientManager,
        knownSelectedServers,
      ),
      mcpClientManager,
      knownSelectedServers,
    );

  return {
    allTools,
    enhancedSystemPrompt,
    resolvedTemperature,
    scrubMessages,
  };
}
