import { useMemo } from "react";
import type { UIMessage } from "ai";
import type { XRayPayloadResponse } from "@/lib/apis/mcp-xray-api";
import type { ToolDefinition, ToolServerMap } from "@/lib/apis/mcp-tools-api";

const DESCRIPTION_MAX_LENGTH = 160;

function truncateDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= DESCRIPTION_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, DESCRIPTION_MAX_LENGTH - 3)}...`;
}

/**
 * Build the "Connected MCP Tools" system prompt section that the server
 * appends before sending to the model. Replicates the server-side
 * `buildMcpToolInventoryPrompt` logic from chat-v2-orchestration.ts.
 */
function buildToolInventoryPrompt(
  toolDefinitions: Record<string, ToolDefinition>,
  toolServerMap: ToolServerMap,
): string {
  const serverGroups = new Map<string, Array<{ name: string; description?: string }>>();

  for (const [name, def] of Object.entries(toolDefinitions)) {
    const serverId = toolServerMap[name];
    if (!serverId) continue;

    const existing = serverGroups.get(serverId) ?? [];
    existing.push({ name, description: truncateDescription(def.description) });
    serverGroups.set(serverId, existing);
  }

  const sections = [
    "## Connected MCP Tools",
    "Tool availability can change between turns. Only the MCP tools listed in this section are currently callable.",
    "If the user asks what tools or servers are available, answer from this list instead of saying you do not have MCP visibility.",
    "If a tool was mentioned earlier in the conversation but is not listed here, do not call it and do not claim it is still available.",
  ];

  if (serverGroups.size === 0) {
    sections.push("No MCP tools are currently connected.");
    return sections.join("\n\n");
  }

  sections.push(
    "You have direct access to the following MCP tools.",
    "If the user explicitly asks you to call or use one of these tools by name, call it instead of claiming you do not have it.",
  );

  const serverSections = Array.from(serverGroups.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((serverId) => {
      const toolLines = [...(serverGroups.get(serverId) ?? [])]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ name, description }) =>
          description ? `- ${name}: ${description}` : `- ${name}`,
        )
        .join("\n");
      return `Server ${serverId}:\n${toolLines}`;
    })
    .join("\n\n");

  sections.push(serverSections);
  return sections.join("\n\n");
}

/**
 * Assembles the Raw view payload (`{ system, tools, messages }`) entirely
 * client-side from data that is already available — no server round-trip.
 */
export function useDebouncedXRayPayload({
  systemPrompt,
  messages,
  toolDefinitions,
  toolServerMap,
}: {
  systemPrompt: string | undefined;
  messages: UIMessage[];
  toolDefinitions: Record<string, ToolDefinition>;
  toolServerMap: ToolServerMap;
}) {
  const hasMessages = messages.length > 0;

  const payload = useMemo<XRayPayloadResponse | null>(() => {
    if (!hasMessages) return null;

    const tools: Record<string, ToolDefinition> = {};
    for (const [name, def] of Object.entries(toolDefinitions)) {
      tools[name] = {
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema ?? {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      };
    }

    const toolInventory = buildToolInventoryPrompt(toolDefinitions, toolServerMap);
    const enhancedSystemPrompt = [systemPrompt, toolInventory]
      .filter((s): s is string => Boolean(s?.trim()))
      .map((s) => s.trim())
      .join("\n\n");

    return {
      system: enhancedSystemPrompt,
      tools,
      messages: messages as unknown[],
    };
  }, [hasMessages, systemPrompt, messages, toolDefinitions, toolServerMap]);

  return {
    payload,
    loading: false,
    error: null,
    refetch: () => {},
    hasMessages,
  };
}
