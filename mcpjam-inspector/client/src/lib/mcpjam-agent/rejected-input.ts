import type { UIMessage } from "ai";
import { isGuestInputTooLargeMessage } from "@/lib/mcpjam-limit";

function lastUserTurn(messages: UIMessage[]): number {
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== "user") index -= 1;
  return index;
}

// A later model step can hit the same size limit after tools have acted. That
// exchange has to stay: removing it would hide the tools' actions from the
// next request.
function toolsRanAfter(messages: UIMessage[], index: number): boolean {
  return messages
    .slice(index + 1)
    .some((message) =>
      message.parts.some(
        (part) => part.type.startsWith("tool-") || part.type === "dynamic-tool",
      ),
    );
}

export function rejectedInputTurn(
  messages: UIMessage[],
  errorMessage: string | undefined,
): { messages: UIMessage[]; text: string } | null {
  if (!isGuestInputTooLargeMessage(errorMessage)) return null;
  const index = lastUserTurn(messages);
  if (index < 0) return null;
  if (toolsRanAfter(messages, index)) return null;
  return {
    messages: messages.slice(0, index),
    text: messages[index].parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  };
}

/** A size refusal whose turn has to stay, so any next request is refused too. */
export function conversationTooLarge(
  messages: UIMessage[],
  errorMessage: string | undefined,
): boolean {
  if (!isGuestInputTooLargeMessage(errorMessage)) return false;
  const index = lastUserTurn(messages);
  return index >= 0 && toolsRanAfter(messages, index);
}
