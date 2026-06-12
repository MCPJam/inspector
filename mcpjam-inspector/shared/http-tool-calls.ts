import { ModelMessage } from "@ai-sdk/provider-utils";
import {
  type MCPClientManager,
  isMcpAppTool,
  scrubMetaAndStructuredContentFromToolResult,
} from "@mcpjam/sdk";
import { ToolResultPart } from "ai";
import { isAbortError } from "./abort-errors";
import { isClientFulfilledToolName } from "./client-fulfilled-tools";

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

function isSkippableClientFulfilledToolCall(
  toolName: string,
  tool: unknown,
  skipNonExecutableTools: boolean | undefined,
): boolean {
  return (
    skipNonExecutableTools === true &&
    isClientFulfilledToolName(toolName) &&
    !!tool &&
    typeof tool === "object" &&
    typeof (tool as { execute?: unknown }).execute !== "function"
  );
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

type ExecuteToolCallOptionsBase = {
  /**
   * When provided, `tool.execute(input, { ..., abortSignal })` receives the
   * signal so each tool implementation can self-cancel its in-flight work.
   * Abort propagates as a thrown `AbortError`; it is NOT stored as a
   * tool-result error (that would poison conversation history with a fake
   * model-visible failure).
   */
  abortSignal?: AbortSignal;
  /**
   * Optional predicate that limits which tool calls get executed in this
   * pass. Unresolved tool calls whose `toolName` returns `false` are
   * skipped (left unresolved) — they will neither execute nor get an
   * error tool-result. Used by progressive discovery to run meta-tool
   * calls before pausing the turn for approval on real MCP tools.
   */
  filterToolName?: (toolName: string) => boolean;
  /**
   * SEP-1865 App-Provided Tools: when true, tool calls whose name isn't in
   * the tool index OR whose tool entry has no `execute` function are SKIPPED
   * (no result written, no throw). Used by the MCPJam free-model handler so
   * that mixed steps containing both server tools and app-aliased tools
   * execute the server tools server-side and leave the app tool calls
   * unresolved — the caller then pauses and lets the client fulfill them
   * in-iframe via `useChat.onToolCall`.
   *
   * Without this flag, app aliases would either trigger "Tool not found" or
   * `tool.execute is not a function`, corrupting the conversation history.
   */
  skipNonExecutableTools?: boolean;
};

type ExecuteToolCallOptions = ExecuteToolCallOptionsBase &
  (
    | { tools: ToolsMap }
    | { toolsets: Toolsets }
    | { clientManager: MCPClientManager; serverIds?: string[] }
  );

export async function executeToolCallsFromMessages(
  messages: ModelMessage[],
  options: ExecuteToolCallOptions,
): Promise<ModelMessage[]> {
  const signal = options.abortSignal;
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error("Aborted"), { name: "AbortError" });
  }
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

  const resultsByAssistantIdx = new Map<number, ModelMessage[]>();
  const allNewResults: ModelMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (
      !msg ||
      msg.role !== "assistant" ||
      !Array.isArray((msg as any).content)
    )
      continue;
    for (const content of (msg as any).content) {
      if (
        content?.type === "tool-call" &&
        !existingToolResultIds.has(content.toolCallId) &&
        (!options.filterToolName ||
          options.filterToolName(content.toolName as string))
      ) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : Object.assign(new Error("Aborted"), { name: "AbortError" });
        }
        try {
          const toolName: string = content.toolName;
          const tool = index[toolName];
          const directTool = tools[toolName];
          if (!tool) {
            if (
              isSkippableClientFulfilledToolCall(
                toolName,
                directTool,
                options.skipNonExecutableTools,
              )
            ) {
              continue;
            }
            throw new Error(`Tool '${toolName}' not found`);
          }
          if (typeof tool.execute !== "function") {
            if (
              isSkippableClientFulfilledToolCall(
                toolName,
                tool,
                options.skipNonExecutableTools,
              )
            ) {
              continue;
            }
            throw new Error(`Tool '${toolName}' has no execute function`);
          }
          const toolCall = content as {
            input?: unknown;
            args?: unknown;
          };
          const input = toolCall.input ?? toolCall.args ?? {};
          const result = await tool.execute(input, {
            toolCallId: content.toolCallId,
            messages,
            ...(signal ? { abortSignal: signal } : {}),
          });

          // If a tool ignored the signal (or returned `result` after the
          // signal fired) the result must NOT be serialized into a
          // tool-result — that would persist into conversation history
          // and look like a completed tool call to the next turn.
          if (signal?.aborted) {
            throw signal.reason instanceof Error
              ? signal.reason
              : Object.assign(new Error("Aborted"), { name: "AbortError" });
          }

          // AI SDK tool contract: when a tool defines `toModelOutput`, the
          // model-visible output is its mapping of the implementation result
          // — e.g. the eval `computer` tool turns `{screenshotBase64}` into
          // `{type:"content", value:[{type:"image-data",…}]}` so the model
          // sees the screenshot as an image instead of a base64 JSON blob.
          // The raw implementation result is NOT duplicated onto the part
          // (`result:` below) in this branch: content outputs already carry
          // the full model-facing payload, and double-shipping screenshots
          // would bloat every subsequent per-step request body.
          const toModelOutput = (
            tool as {
              toModelOutput?: (ctx: {
                output: unknown;
              }) => ToolResultPart | Promise<ToolResultPart>;
            }
          ).toModelOutput;
          if (typeof toModelOutput === "function") {
            const mappedOutput = await toModelOutput({ output: result });
            const toolResultMessage: ModelMessage = {
              role: "tool" as const,
              content: [
                {
                  type: "tool-result",
                  toolCallId: content.toolCallId,
                  toolName: toolName,
                  output: mappedOutput,
                  serverId: extractServerId(toolName),
                },
              ],
            } as any;
            if (!resultsByAssistantIdx.has(i)) resultsByAssistantIdx.set(i, []);
            resultsByAssistantIdx.get(i)!.push(toolResultMessage);
            allNewResults.push(toolResultMessage);
            continue;
          }

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
          if (!resultsByAssistantIdx.has(i)) resultsByAssistantIdx.set(i, []);
          resultsByAssistantIdx.get(i)!.push(toolResultMessage);
          allNewResults.push(toolResultMessage);
        } catch (error: any) {
          // Abort errors must propagate — they represent user/client
          // cancellation, NOT a tool failure. Capturing them as an
          // error-text result would persist a phantom "tool failed" into
          // conversation history.
          if (isAbortError(error)) {
            throw error;
          }
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
          if (!resultsByAssistantIdx.has(i)) resultsByAssistantIdx.set(i, []);
          resultsByAssistantIdx.get(i)!.push(errorToolResultMessage);
          allNewResults.push(errorToolResultMessage);
        }
      }
    }
  }

  // Insert right after corresponding assistant messages (reverse order to preserve indices)
  const sortedKeys = [...resultsByAssistantIdx.keys()].sort((a, b) => b - a);
  for (const idx of sortedKeys) {
    messages.splice(idx + 1, 0, ...resultsByAssistantIdx.get(idx)!);
  }

  return allNewResults;
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
