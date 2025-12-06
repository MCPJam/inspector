/**
 * playground-helpers.ts
 *
 * Helper functions for the UI Playground, including
 * message injection for deterministic tool executions.
 */

import { generateId, type UIMessage, type DynamicToolUIPart } from "ai";

type DeterministicToolState = "output-available" | "output-error";

interface DeterministicToolOptions {
  /** Tool state - defaults to 'output-available' */
  state?: DeterministicToolState;
  /** Error text - required when state is 'output-error' */
  errorText?: string;
}

/**
 * Create messages for a deterministic tool execution.
 * Injects a user message describing the execution and an assistant
 * message with the tool call result (which renders the widget).
 * Includes invocation status message (ChatGPT-style "Invoked [toolName]").
 */
export function createDeterministicToolMessages(
  toolName: string,
  params: Record<string, unknown>,
  result: unknown,
  toolMeta: Record<string, unknown> | undefined,
  options?: DeterministicToolOptions,
): { messages: UIMessage[]; toolCallId: string } {
  // Validate toolName
  if (!toolName?.trim()) {
    throw new Error("toolName is required");
  }

  const toolCallId = `playground-${generateId()}`;
  const state = options?.state ?? "output-available";

  // Get custom invoked message from tool metadata if available
  const invokedMessage = toolMeta?.["openai/toolInvocation/invoked"] as
    | string
    | undefined;

  // Format invocation status text
  const invocationText = invokedMessage || `Invoked \`${toolName}\``;

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
        }
      : {
          type: "dynamic-tool",
          toolCallId,
          toolName,
          state: "output-available",
          input: params,
          output: result,
        };

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
      parts: [
        // Invocation status (ChatGPT-style "Invoked [toolName]")
        {
          type: "text",
          text: invocationText,
        },
        // Tool result (renders widget)
        toolPart,
      ],
    },
  ];

  return { messages, toolCallId };
}
