/**
 * playground-helpers.ts
 *
 * Helper functions for the UI Playground, including
 * message injection for deterministic tool executions.
 */

import { generateId, type UIMessage, type DynamicToolUIPart } from "ai";
import { detectUIType } from "@/lib/mcp-ui/mcp-apps-utils";
import { extractDisplayFromToolResult } from "@/components/chat-v2/shared/tool-result-text";
import { mergeMcpToolOriginMetadata } from "@/shared/mcp-tool-origin-metadata";
import { hasMcpToolResultImageCandidate } from "@/components/chat-v2/shared/mcp-tool-result-image-preview";

type DeterministicToolState = "output-available" | "output-error";

interface DeterministicToolOptions {
  /** Tool state - defaults to 'output-available' */
  state?: DeterministicToolState;
  /** Error text - required when state is 'output-error' */
  errorText?: string;
  /** Optional fixed toolCallId for in-place updates */
  toolCallId?: string;
  /** Optional model-facing output used by trace/prelude callers, not UI storage. */
  modelOutput?: unknown;
  /** Host policy for human-facing tool-result image rendering. */
  mcpToolResultImageRendering?: "none" | "panel" | "inline";
}

function readServerIdFromToolMeta(
  toolMeta: Record<string, unknown> | undefined
): string | undefined {
  const serverId = toolMeta?._serverId ?? toolMeta?.serverId;
  return typeof serverId === "string" && serverId.length > 0
    ? serverId
    : undefined;
}

/**
 * Create messages for a deterministic tool execution.
 * Injects a user message describing the execution and an assistant
 * message with the tool call result.
 * Includes invocation status message (ChatGPT-style "Invoked [toolName]").
 */
export function createDeterministicToolMessages(
  toolName: string,
  params: Record<string, unknown>,
  result: unknown,
  toolMeta: Record<string, unknown> | undefined,
  options?: DeterministicToolOptions
): { messages: UIMessage[]; toolCallId: string } {
  // Validate toolName
  if (!toolName?.trim()) {
    throw new Error("toolName is required");
  }

  const toolCallId = options?.toolCallId ?? `playground-${generateId()}`;
  const state = options?.state ?? "output-available";
  const toolOutput = result;

  // Get custom invoked message from tool metadata if available
  const invokedMessage = toolMeta?.["openai/toolInvocation/invoked"] as
    | string
    | undefined;

  // Format invocation status text
  const invocationText = invokedMessage || `Invoked \`${toolName}\``;
  const uiType = detectUIType(toolMeta, result);
  const isTextTool = uiType === null;
  const serverId = readServerIdFromToolMeta(toolMeta);
  const providerMetadata = mergeMcpToolOriginMetadata(undefined, serverId);

  // Properly typed dynamic tool part based on state
  const toolPart: DynamicToolUIPart =
    state === "output-error"
      ? {
          type: "dynamic-tool",
          toolCallId,
          toolName,
          state: "output-error",
          input: params,
          errorText: options?.errorText ?? "Unknown error",
          ...(providerMetadata
            ? { callProviderMetadata: providerMetadata }
            : {}),
        }
      : {
          type: "dynamic-tool",
          toolCallId,
          toolName,
          state: "output-available",
          input: params,
          output: toolOutput,
          ...(providerMetadata
            ? { callProviderMetadata: providerMetadata }
            : {}),
        };

  const assistantParts: UIMessage["parts"] = [
    // Invocation status (ChatGPT-style "Invoked [toolName]")
    {
      type: "text",
      text: invocationText,
    },
    // Tool result
    toolPart,
  ];

  // Non-UI tools should surface deterministic text output in chat.
  if (isTextTool) {
    if (state === "output-error") {
      assistantParts.push({
        type: "text",
        text: `Tool error: ${options?.errorText ?? "Unknown error"}`,
      });
    } else {
      const suppressInlineImageDataResult =
        (options?.mcpToolResultImageRendering ?? "inline") === "inline" &&
        hasMcpToolResultImageCandidate(result);
      const display = suppressInlineImageDataResult
        ? null
        : extractDisplayFromToolResult(result);
      if (display?.kind === "json") {
        assistantParts.push({
          type: "data-result",
          data: display.value,
          autoHeight: true,
          ...(serverId ? { serverId } : {}),
        } as any);
      } else if (display?.kind === "text") {
        assistantParts.push({
          type: "text",
          text: display.text,
        });
      }
    }
  }

  const messages: UIMessage[] = [
    // User message showing the deterministic execution request
    {
      id: `user-${toolCallId}`,
      role: "user",
      parts: [
        {
          type: "text",
          text: `Execute \`${toolName}\``,
        },
      ],
    },
    // Assistant message with invocation status and dynamic tool result
    {
      id: `assistant-${toolCallId}`,
      role: "assistant",
      parts: assistantParts,
    },
  ];

  return { messages, toolCallId };
}
