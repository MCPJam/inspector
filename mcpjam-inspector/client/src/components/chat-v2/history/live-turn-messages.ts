import type { UIMessage } from "ai";
import type { DirectChatLiveTurn } from "@/hooks/use-direct-chat-session-subscription";

function liveUserId(turnId: string) {
  return `remote-live-user-${turnId}`;
}

function liveAssistantId(turnId: string) {
  return `remote-live-assistant-${turnId}`;
}

function sameMessages(left: UIMessage[], right: UIMessage[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function applyDirectChatLiveTurn(
  messages: UIMessage[],
  liveTurn: DirectChatLiveTurn,
): UIMessage[] {
  if (liveTurn.status !== "streaming") {
    return messages;
  }

  const userId = liveUserId(liveTurn.turnId);
  const assistantId = liveAssistantId(liveTurn.turnId);
  const next = messages.filter(
    (message) => message.id !== userId && message.id !== assistantId,
  );
  const promptText = liveTurn.promptText?.trim();
  const assistantText = liveTurn.assistantText;

  if (promptText) {
    next.push({
      id: userId,
      role: "user",
      parts: [{ type: "text", text: promptText }],
    } as UIMessage);
  }

  if (assistantText.trim().length > 0) {
    next.push({
      id: assistantId,
      role: "assistant",
      parts: [{ type: "text", text: assistantText }],
    } as UIMessage);
  }

  return sameMessages(messages, next) ? messages : next;
}
