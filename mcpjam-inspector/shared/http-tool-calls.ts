import { ModelMessage } from "@ai-sdk/provider-utils";
import {
  type MCPClientManager,
  isMcpAppTool,
  scrubMetaAndStructuredContentFromToolResult,
} from "@mcpjam/sdk";
import { ToolResultPart } from "ai";

type ToolsMap = Record<string, any>;
type Toolsets = Record<string, ToolsMap>;

/**
 * Flatten toolsets and attach serverId metadata to each tool
 * This preserves the server origin for each tool to enable correct routing
 */
function flattenToolsetsWithServerId(toolsets: Toolsets): ToolsMap {
  const flattened: ToolsMap = {};
  for (const [serverId, serverTools] of Object.entries(toolsets || {})) {
    if (serverTools && typeof serverTools === "object") {
      for (const [toolName, tool] of Object.entries(serverTools)) {
        // Attach serverId metadata to each tool
        flattened[toolName] = {
          ...tool,
          _serverId: serverId,
        };
      }
    }
  }
  return flattened;
}

function buildIndexWithAliases(tools: ToolsMap): ToolsMap {
  const index: ToolsMap = {};
  for (const [toolName, tool] of Object.entries<any>(tools || {})) {
    if (!tool || typeof tool !== "object" || !("execute" in tool)) continue;
    const idx = toolName.indexOf("_");
    const pure =
      idx > -1 && idx < toolName.length - 1
        ? toolName.slice(idx + 1)
        : toolName;
    if (!(toolName in index)) index[toolName] = tool;
    if (!(pure in index)) index[pure] = tool;
  }
  return index;
}

export const hasUnresolvedToolCalls = (messages: ModelMessage[]): boolean => {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "assistant" && Array.isArray((msg as any).content)) {
      for (const c of (msg as any).content) {
        if (c?.type === "tool-call") toolCallIds.add(c.toolCallId);
      }
    } else if (msg.role === "tool" && Array.isArray((msg as any).content)) {
      for (const c of (msg as any).content) {
        if (c?.type === "tool-result") toolResultIds.add(c.toolCallId);
      }
    }
  }
  for (const id of toolCallIds) if (!toolResultIds.has(id)) return true;
  return false;
};

type ExecuteToolCallOptions =
  | { tools: ToolsMap }
  | { toolsets: Toolsets }
  | { clientManager: MCPClientManager; serverIds?: string[] };

export async function executeToolCallsFromMessages(
  messages: ModelMessage[],
  options: ExecuteToolCallOptions,
): Promise<void> {
  // Build tools with serverId metadata
  let tools: ToolsMap = {};

  if ("clientManager" in options) {
    const flattened = await options.clientManager.getToolsForAiSdk(
      options.serverIds,
    );
    tools = flattened as ToolsMap;
  } else if ("toolsets" in options) {
    const toolsets = options.toolsets as Toolsets;
    tools = flattenToolsetsWithServerId(toolsets);
  } else {
    tools = options.tools as ToolsMap;
  }

  const index = buildIndexWithAliases(tools);

  const extractServerId = (toolName: string): string | undefined => {
    const tool = index[toolName];
    return tool?._serverId;
  };

  // Collect existing tool-result IDs
  const existingToolResultIds = new Set<string>();
  for (const msg of messages) {
    if (!msg || msg.role !== "tool" || !Array.isArray((msg as any).content))
      continue;
    for (const c of (msg as any).content) {
      if (c?.type === "tool-result") existingToolResultIds.add(c.toolCallId);
    }
  }

  const toolResultsToAdd: ModelMessage[] = [];
  for (const msg of messages) {
    if (
      !msg ||
      msg.role !== "assistant" ||
      !Array.isArray((msg as any).content)
    )
      continue;
    for (const content of (msg as any).content) {
      if (
        content?.type === "tool-call" &&
        !existingToolResultIds.has(content.toolCallId)
      ) {
        try {
          const toolName: string = content.toolName;
          const tool = index[toolName];
          if (!tool) throw new Error(`Tool '${toolName}' not found`);
          const input = content.input || {};
          const result = await tool.execute(input);

          let output: ToolResultPart;
          if (result !== undefined && result !== null) {
            if (typeof result === "object") {
              const serialized = serializeToolResult(result);
              if (serialized.success) {
                output = { type: "json", value: serialized.value } as any;
              } else {
                output = {
                  type: "text",
                  value: serialized.fallbackText,
                } as any;
              }
            } else {
              output = { type: "text", value: String(result) } as any;
            }
          } else {
            output = { type: "json", value: null } as any;
          }

          // Extract serverId from tool name
          const serverId = extractServerId(toolName);

          // For MCP app tools, scrub _meta and structuredContent from the
          // output that goes to the LLM, while preserving the full result
          // for the UI.
          let llmOutput = output;
          if (
            "clientManager" in options &&
            serverId &&
            result &&
            typeof result === "object"
          ) {
            const toolsMetadata =
              options.clientManager.getAllToolsMetadata(serverId);
            const toolMeta = toolsMetadata[toolName];
            if (isMcpAppTool(toolMeta)) {
              const scrubbed = scrubMetaAndStructuredContentFromToolResult(
                result as any,
              );
              const scrubbedSerialized = serializeToolResult(scrubbed);
              if (scrubbedSerialized.success) {
                llmOutput = {
                  type: "json",
                  value: scrubbedSerialized.value,
                } as any;
              }
            }
          }

          const toolResultMessage: ModelMessage = {
            role: "tool" as const,
            content: [
              {
                type: "tool-result",
                toolCallId: content.toolCallId,
                toolName: toolName,
                output: llmOutput,
                // Preserve full result including _meta for UI hydration
                result: result,
                // Add serverId for OpenAI component resolution
                serverId,
              },
            ],
          } as any;
          toolResultsToAdd.push(toolResultMessage);
        } catch (error: any) {
          const errorOutput: ToolResultPart = {
            type: "error-text",
            value: error instanceof Error ? error.message : String(error),
          } as any;
          const errorToolResultMessage: ModelMessage = {
            role: "tool" as const,
            content: [
              {
                type: "tool-result",
                toolCallId: content.toolCallId,
                toolName: content.toolName,
                output: errorOutput,
              },
            ],
          } as any;
          toolResultsToAdd.push(errorToolResultMessage);
        }
      }
    }
  }

  messages.push(...toolResultsToAdd);
}

function serializeToolResult(
  result: Record<string, unknown> | Array<unknown> | object,
):
  | { success: true; value: unknown }
  | { success: false; fallbackText: string } {
  const seen = new WeakSet<object>();

  try {
    const sanitized = JSON.parse(
      JSON.stringify(result, (_key, value) => {
        if (typeof value === "bigint") {
          return value.toString();
        }

        if (typeof value === "function") {
          return undefined;
        }

        if (value && typeof value === "object") {
          if (seen.has(value as object)) {
            return undefined;
          }
          seen.add(value as object);
        }

        return value;
      }),
    );

    return { success: true, value: sanitized ?? null };
  } catch (error) {
    let fallbackText: string;
    try {
      fallbackText = JSON.stringify(result, null, 2) ?? String(result);
    } catch {
      fallbackText = String(result);
    }

    if (error instanceof Error) {
      fallbackText = `Failed to serialize tool result: ${error.message}. Raw result: ${fallbackText}`;
    }

    return {
      success: false,
      fallbackText,
    };
  }
}
