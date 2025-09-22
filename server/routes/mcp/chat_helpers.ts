import { ModelMessage } from '@ai-sdk/provider-utils';
import { MCPJamClientManager } from '../../services/mcpjam-client-manager';

// Helper function to check if there are unresolved tool calls
export const hasUnresolvedToolCalls = (messages: ModelMessage[]): boolean => {
  console.log(
    'checking for unresolved tool calls',
    JSON.stringify(messages, null, 2)
  );

  // Collect all tool call IDs from assistant messages
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (!msg) continue;

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Look for tool calls in assistant messages
      for (const content of msg.content) {
        if (content.type === 'tool-call') {
          toolCallIds.add(content.toolCallId);
        }
      }
    } else if (msg.role === 'tool' && Array.isArray(msg.content)) {
      // Look for tool results in tool messages
      for (const content of msg.content) {
        if (content.type === 'tool-result') {
          toolResultIds.add(content.toolCallId);
        }
      }
    }
  }

  // Check if any tool calls don't have corresponding results
  for (const toolCallId of toolCallIds) {
    if (!toolResultIds.has(toolCallId)) {
      console.log(`Found unresolved tool call: ${toolCallId}`);
      return true;
    }
  }

  return false;
};

// Helper function to execute tool calls
export const executeToolCallsFromMessages = async (
  messages: ModelMessage[],
  manager: MCPJamClientManager,
): Promise<void> => {
  await manager.executeToolCallsFromMessages(messages);
};