import {
  PLUGIN_MESSAGE_TEXT_PART,
  pluginMessageTextSchema,
} from "./plugin-message.js";

export const PLUGIN_MESSAGE_HISTORY_TITLE = "mcpjamMessageTitle";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Presentation only. Match the original user text exactly; never copy an App
 * intent, source handle, operation, receipt, or execution metadata into history. */
export function preservePluginMessageTitles(
  history: unknown[],
  source: unknown[],
): unknown[] {
  const users = source.filter((item) => record(item) && item.role === "user");
  let ordinal = 0;
  return history.map((message) => {
    if (!record(message) || message.role !== "user") return message;
    const original = users[ordinal++];
    if (!record(original) || !Array.isArray(original.parts)) return message;
    const sourceParts = original.parts;
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    if (!Array.isArray(content) || content.length !== sourceParts.length)
      return message;
    let changed = false;
    const parts = content.map((part, index) => {
      const input = sourceParts[index];
      if (
        !record(part) ||
        part.type !== "text" ||
        !record(input) ||
        input.type !== PLUGIN_MESSAGE_TEXT_PART
      )
        return part;
      const parsed = pluginMessageTextSchema.safeParse(input.data);
      if (!parsed.success || parsed.data.text !== part.text) return part;
      changed = true;
      return { ...part, [PLUGIN_MESSAGE_HISTORY_TITLE]: parsed.data.title };
    });
    return changed ? { ...message, content: parts } : message;
  });
}

export function readPluginMessageHistoryTitle(
  value: unknown,
): string | undefined {
  if (!record(value) || typeof value.text !== "string") return undefined;
  const parsed = pluginMessageTextSchema.safeParse({
    title: value[PLUGIN_MESSAGE_HISTORY_TITLE],
    text: value.text,
  });
  return parsed.success ? parsed.data.title : undefined;
}
