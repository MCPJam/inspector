/**
 * Shape checks for a chat history the browser sent.
 *
 * The web chat routes accept `messages` unchecked, and the history goes to
 * the AI SDK's `convertToModelMessages`, which assumes UI message shape: it
 * reads `message.parts`, each part's `type`, and parses every file part's
 * `url` with `new URL`. A history that breaks one of those (a message saved
 * before UI parts, a null part, a file part with a relative or missing url)
 * threw a TypeError there and failed the turn as an internal error. Only that
 * shape is checked here; content and provenance are `verifyClientHistory`'s.
 */

export type MalformedHistoryProblem =
  | "message_not_object"
  | "parts_missing"
  | "part_not_object"
  | "part_type_missing"
  | "file_url_invalid";

export interface MalformedHistory {
  messageIndex: number;
  partIndex?: number;
  problem: MalformedHistoryProblem;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// `convertToModelMessages` parses `url` for these unless a file part carries a
// provider reference instead; a reasoning file is always parsed.
function hasParseableFileUrl(part: Record<string, unknown>): boolean {
  if (part.type === "file" && part.providerReference != null) return true;
  return typeof part.url === "string" && URL.canParse(part.url);
}

/** The first part of `messages` conversion cannot read, or null. */
export function findMalformedHistory(
  messages: readonly unknown[],
): MalformedHistory | null {
  for (const [messageIndex, message] of messages.entries()) {
    if (!isRecord(message)) {
      return { messageIndex, problem: "message_not_object" };
    }
    if (!Array.isArray(message.parts)) {
      return { messageIndex, problem: "parts_missing" };
    }
    for (const [partIndex, part] of message.parts.entries()) {
      if (!isRecord(part)) {
        return { messageIndex, partIndex, problem: "part_not_object" };
      }
      if (typeof part.type !== "string") {
        return { messageIndex, partIndex, problem: "part_type_missing" };
      }
      if (
        (part.type === "file" || part.type === "reasoning-file") &&
        !hasParseableFileUrl(part)
      ) {
        return { messageIndex, partIndex, problem: "file_url_invalid" };
      }
    }
  }
  return null;
}
