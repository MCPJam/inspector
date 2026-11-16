import type { UIMessage } from "ai";
import {
  guestInputTooLargeNumbers,
  isGuestInputTooLargeMessage,
} from "@/lib/mcpjam-limit";

export function rejectedInputTurn(
  messages: UIMessage[],
  errorMessage: string | undefined,
): { messages: UIMessage[]; text: string } | null {
  if (!isGuestInputTooLargeMessage(errorMessage)) return null;
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== "user") index -= 1;
  if (index < 0) return null;
  // A later model step can hit the same size limit after tools have acted.
  // Keep that exchange: removing it would hide actions from the next request.
  if (
    messages
      .slice(index + 1)
      .some((message) =>
        message.parts.some(
          (part) =>
            part.type.startsWith("tool-") || part.type === "dynamic-tool",
        ),
      )
  )
    return null;
  return {
    messages: messages.slice(0, index),
    text: messages[index].parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  };
}

/** A size refusal the next message can't fix, so any next request is refused too. */
export function conversationTooLarge(
  messages: UIMessage[],
  errorMessage: string | undefined,
): boolean {
  if (!errorMessage || !isGuestInputTooLargeMessage(errorMessage)) return false;
  const kept = rejectedInputTurn(messages, errorMessage);
  // The refused turn has to stay.
  if (!kept) return true;
  // Dropping it may still leave too much, as when a reload brings an earlier
  // paste back. The backend counts JSON characters / 3
  // (mcpjam-backend convex/lib/streamCostEstimate.ts); the client only sees
  // UI messages, so this is close, not exact.
  const numbers = guestInputTooLargeNumbers(errorMessage);
  const refused = messages[kept.messages.length];
  return (
    numbers !== null &&
    numbers.estimatedInputTokens - JSON.stringify(refused).length / 3 >
      numbers.limit
  );
}
