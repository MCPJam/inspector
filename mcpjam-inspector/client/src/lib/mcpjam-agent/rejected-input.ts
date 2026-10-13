import type { UIMessage } from "ai";
import { isGuestInputTooLargeMessage } from "@/lib/mcpjam-limit";

export function rejectedInputTurn(
  messages: UIMessage[],
  errorMessage: string | undefined,
): { messages: UIMessage[]; text: string } | null {
  if (!isGuestInputTooLargeMessage(errorMessage)) return null;
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== "user") index -= 1;
  if (index < 0) return null;
  return {
    messages: messages.slice(0, index),
    text: messages[index].parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  };
}
