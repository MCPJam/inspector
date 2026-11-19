import { isToolUIPart, type UIMessage } from "ai";
import { extractUserMessageText } from "@/components/chat-v2/shared/chat-helpers";

// Mirrors `promptSimilarity` in the backend's convex/lib/chatSessionImport.ts
// so in-conversation repeats match the same way past conversations do.
const STOP_WORDS = new Set(
  "a an and are can could do does for from how in is it me my of on or please the this that to what with would you".split(
    " ",
  ),
);
export const SIMILAR_PROMPT_MIN_SCORE = 0.6;
const MIN_PROMPT_WORDS = 2;

function promptWordSet(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word)),
  );
}

export function promptSimilarity(left: string, right: string): number {
  const a = promptWordSet(left);
  const b = promptWordSet(right);
  if (a.size < MIN_PROMPT_WORDS || b.size < MIN_PROMPT_WORDS) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export type PromptTurn = { promptIndex: number; text: string };

function calledTools(message: UIMessage): boolean {
  return message.parts.some((part) => isToolUIPart(part));
}

/** The latest user prompt, if its turn finished with at least one tool call. */
export function latestToolPromptTurn(messages: UIMessage[]): PromptTurn | null {
  let lastUserIndex = -1;
  let promptIndex = -1;
  messages.forEach((message, index) => {
    if (message.role !== "user") return;
    lastUserIndex = index;
    promptIndex += 1;
  });
  if (lastUserIndex < 0) return null;
  const replies = messages.slice(lastUserIndex + 1);
  if (!replies.some((m) => m.role === "assistant" && calledTools(m))) {
    return null;
  }
  const text = extractUserMessageText(messages[lastUserIndex]).trim();
  return text ? { promptIndex, text } : null;
}

export type CompareLaneTurn = { chatSessionId: string; messages: UIMessage[] };

/** The first compare lane whose latest turn called tools. */
export function pickCompareTipSource(
  lanes: CompareLaneTurn[],
): CompareLaneTurn | undefined {
  return lanes.find((lane) => latestToolPromptTurn(lane.messages) !== null);
}

/** An earlier prompt in this conversation that `turn` repeats. */
export function findRepeatInConversation(
  messages: UIMessage[],
  turn: PromptTurn,
): string | null {
  let promptIndex = -1;
  let best: { text: string; score: number } | null = null;
  for (const message of messages) {
    if (message.role !== "user") continue;
    promptIndex += 1;
    if (promptIndex >= turn.promptIndex) break;
    const text = extractUserMessageText(message).trim();
    const score = promptSimilarity(turn.text, text);
    if (score >= SIMILAR_PROMPT_MIN_SCORE && (!best || score > best.score)) {
      best = { text, score };
    }
  }
  return best?.text ?? null;
}
