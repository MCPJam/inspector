import { getToolName, isToolUIPart, type UIMessage } from "ai";

const CARD_TOOLS = new Set([
  "ui_eval_question",
  "ui_eval_propose_cases",
  "ui_eval_generate_cases", // Retained history from before guided creation.
]);

/** Presentation only: retain complete tool history for the AI SDK transport. */
export function describeTranscript(messages: UIMessage[]): UIMessage[] {
  return messages.flatMap((message) => {
    if (
      message.role === "assistant" &&
      message.parts.some(
        (part) => isToolUIPart(part) && CARD_TOOLS.has(getToolName(part)),
      )
    )
      return [];
    const parts = message.parts.filter(
      (part) => !isToolUIPart(part) && part.type !== "step-start",
    );
    return parts.length ? [{ ...message, parts }] : [];
  });
}
