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
 *
 * MCPJam's own plugin data parts are parsed with zod during conversion, so a
 * part with missing or invalid `data` threw there too. Those parts carry what
 * the user wrote, so they are refused rather than dropped from the turn.
 */

import {
  PLUGIN_MENTION_PART,
  pluginMentionSelectionFits,
  pluginMentionSelectionSchema,
} from "@/shared/plugin-mentions";
import {
  PLUGIN_MESSAGE_TEXT_PART,
  pluginMessageTextSchema,
} from "@/shared/plugin-message";

export type MalformedHistoryProblem =
  | "message_not_object"
  | "message_role_invalid"
  | "parts_missing"
  | "part_not_object"
  | "part_type_missing"
  | "file_url_invalid"
  | "plugin_data_invalid";

export interface MalformedHistory {
  messageIndex: number;
  partIndex?: number;
  problem: MalformedHistoryProblem;
}

// The roles `convertToModelMessages` converts; any other is a MessageConversionError.
const convertibleRoles = new Set<unknown>(["system", "user", "assistant"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The part types whose `url` each role's branch of `convertToModelMessages`
// parses. The system branch keeps only text parts, so it is absent.
const urlPartTypesByRole = new Map<unknown, ReadonlySet<string>>([
  ["user", new Set(["file"])],
  ["assistant", new Set(["file", "reasoning-file"])],
]);

// A file part carrying a provider reference is not parsed; a reasoning file
// always is.
function hasParseableFileUrl(part: Record<string, unknown>): boolean {
  if (part.type === "file" && part.providerReference != null) return true;
  return typeof part.url === "string" && URL.canParse(part.url);
}

// What conversion requires of each plugin part's `data`. A Map, so a part
// type such as "constructor" finds no entry.
const pluginDataReadable = new Map<string, (data: unknown) => boolean>([
  [
    PLUGIN_MESSAGE_TEXT_PART,
    (data) => pluginMessageTextSchema.safeParse(data).success,
  ],
  [
    PLUGIN_MENTION_PART,
    (data) => {
      const parsed = pluginMentionSelectionSchema.safeParse(data);
      return parsed.success && pluginMentionSelectionFits(parsed.data);
    },
  ],
]);

/** The first part of `messages` conversion cannot read, or null. */
export function findMalformedHistory(
  messages: readonly unknown[],
): MalformedHistory | null {
  for (const [messageIndex, message] of messages.entries()) {
    if (!isRecord(message)) {
      return { messageIndex, problem: "message_not_object" };
    }
    if (!convertibleRoles.has(message.role)) {
      return { messageIndex, problem: "message_role_invalid" };
    }
    if (!Array.isArray(message.parts)) {
      return { messageIndex, problem: "parts_missing" };
    }
    for (const [partIndex, part] of message.parts.entries()) {
      if (!isRecord(part)) {
        return { messageIndex, partIndex, problem: "part_not_object" };
      }
      // Every role's parts are read for `type`: conversion first filters all
      // messages for tool parts once a user message follows the first.
      if (typeof part.type !== "string") {
        return { messageIndex, partIndex, problem: "part_type_missing" };
      }
      // The system branch then keeps only text parts and reads nothing else.
      if (message.role === "system") continue;
      if (
        urlPartTypesByRole.get(message.role)?.has(part.type) &&
        !hasParseableFileUrl(part)
      ) {
        return { messageIndex, partIndex, problem: "file_url_invalid" };
      }
      const readable = pluginDataReadable.get(part.type);
      if (readable && !readable(part.data)) {
        return { messageIndex, partIndex, problem: "plugin_data_invalid" };
      }
    }
  }
  return null;
}
