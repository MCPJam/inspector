import { ModelMessage } from "@ai-sdk/provider-utils";
import { LanguageModelV2ToolResultOutput } from "@ai-sdk/provider-v5";
import type { MCPClient } from "@mastra/mcp";

type ToolsMap = Record<string, any>;
type Toolsets = Record<string, ToolsMap>;

function flattenToolsets(toolsets: Toolsets): ToolsMap {
  const flattened: ToolsMap = {};
  for (const serverTools of Object.values(toolsets || {})) {
    if (serverTools && typeof serverTools === "object") {
      Object.assign(flattened, serverTools as any);
    }
  }
  return flattened;
}

function buildIndexWithAliases(tools: ToolsMap): ToolsMap {
  const index: ToolsMap = {};
  for (const [toolName, tool] of Object.entries<any>(tools || {})) {
    if (!tool || typeof tool !== "object" || !("execute" in tool)) continue;
    const idx = toolName.indexOf("_");
    const pure = idx > -1 && idx < toolName.length - 1 ? toolName.slice(idx + 1) : toolName;
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

export async function executeToolCallsFromMessages(
  messages: ModelMessage[],
  options:
    | { tools: ToolsMap }
    | { toolsets: Toolsets }
    | { client: MCPClient },
): Promise<void> {
  console.log("executing unresolved tool calls");

  // Build tools index
  let tools: ToolsMap = {};
  console.log("options", options);
  if ((options as any).client) {
    const toolsets = await (options as any).client.getToolsets();
    tools = flattenToolsets(toolsets as any);
  } else if ((options as any).toolsets) {
    tools = flattenToolsets((options as any).toolsets as any);
  } else {
    tools = (options as any).tools as ToolsMap;
  }
  const index = buildIndexWithAliases(tools);

  // Collect existing tool-result IDs
  const existingToolResultIds = new Set<string>();
  for (const msg of messages) {
    if (!msg || msg.role !== "tool" || !Array.isArray((msg as any).content)) continue;
    for (const c of (msg as any).content) {
      if (c?.type === "tool-result") existingToolResultIds.add(c.toolCallId);
    }
  }

  const toolResultsToAdd: ModelMessage[] = [];
  for (const msg of messages) {
    if (!msg || msg.role !== "assistant" || !Array.isArray((msg as any).content)) continue;
    for (const content of (msg as any).content) {
      if (content?.type === "tool-call" && !existingToolResultIds.has(content.toolCallId)) {
        try {
          const toolName: string = content.toolName;
          console.log(`Executing unresolved tool call: ${toolName} (${content.toolCallId})`);
          const tool = index[toolName];
          if (!tool) throw new Error(`Tool '${toolName}' not found`);
          const input = content.input || {};
          const result = await tool.execute({ context: input });

          let output: LanguageModelV2ToolResultOutput;
          if (result && typeof result === "object" && (result as any).content) {
            const rc: any = (result as any).content;
            if (rc && typeof rc === "object" && "text" in rc && typeof rc.text === "string") {
              output = { type: "text", value: rc.text } as any;
            } else if (rc && typeof rc === "object" && "type" in rc && "value" in rc) {
              output = { type: (rc.type as any) || "text", value: rc.value } as any;
            } else {
              output = { type: "text", value: JSON.stringify(rc) } as any;
            }
          } else {
            output = { type: "text", value: String(result) } as any;
          }

          const toolResultMessage: ModelMessage = {
            role: "tool" as const,
            content: [
              {
                type: "tool-result",
                toolCallId: content.toolCallId,
                toolName: toolName,
                output,
              },
            ],
          } as any;
          toolResultsToAdd.push(toolResultMessage);
        } catch (error: any) {
          console.error(`Error executing tool ${content?.toolName}:`, error);
          const errorOutput: LanguageModelV2ToolResultOutput = {
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


