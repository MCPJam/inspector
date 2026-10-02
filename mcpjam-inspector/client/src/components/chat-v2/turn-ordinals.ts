import type { UIMessage } from "@ai-sdk/react";

/**
 * Map each assistant message to the ordinal of the prompt that opened its turn.
 *
 * This is the client half of a contract with the server. A per-turn rating is
 * stored against the `turnId` the server minted, looked up by the ordinal the
 * server assigned — so this must count prompts exactly the way the server's
 * `getPromptIndex` (`server/utils/live-chat-trace-stream.ts`) does, which is
 * every `role: "user"` message, unfiltered. Filtering internal messages here
 * would make the two disagree and quietly attach ratings to the wrong response.
 *
 * (Context the chat adds on the user's side — an app's widget state, a skill,
 * a tool run by hand — is `role: "user"`, so both sides count it like any
 * other prompt. That is why a widget's cleared state is recorded rather than
 * removed: see `applyWidgetStateUpdates` in `shared/user-context-message.ts`.)
 *
 * An assistant message with no preceding prompt — a seeded greeting — belongs
 * to no turn and is deliberately absent from the map, which is how the render
 * callback knows not to offer a rating for it.
 */
export function buildAssistantPromptIndex(
  messages: readonly Pick<UIMessage, "id" | "role">[]
): Map<string, number> {
  const map = new Map<string, number>();
  let userOrdinal = -1;
  for (const message of messages) {
    if (message.role === "user") {
      userOrdinal += 1;
      continue;
    }
    if (message.role === "assistant" && userOrdinal >= 0 && message.id) {
      map.set(message.id, userOrdinal);
    }
  }
  return map;
}
