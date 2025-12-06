/**
 * playground-helpers.ts
 *
 * Helper functions for the UI Playground, including
 * message injection for deterministic tool executions.
 */

import { generateId, type UIMessage } from "ai";

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
  toolMeta: Record<string, unknown> | undefined
): { messages: UIMessage[]; toolCallId: string } {
  const toolCallId = `playground-${generateId()}`;

  // Get custom invoked message from tool metadata if available
  const invokedMessage = toolMeta?.["openai/toolInvocation/invoked"] as
    | string
    | undefined;

  // Format invocation status text
  const invocationText = invokedMessage || `Invoked \`${toolName}\``;

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
    // Using "dynamic-tool" type so getToolInfo extracts toolName correctly
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
        {
          type: "dynamic-tool",
          toolCallId,
          toolName,
          state: "output-available", // Required state for widget rendering
          input: params,
          output: result,
        } as any,
      ],
    },
  ];

  return { messages, toolCallId };
}

