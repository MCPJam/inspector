import { OpenAIMentionSearchResultSchema } from "@openai/mcp-extensions/server";
import { z } from "zod";
import { mcpAppToolResultSchema } from "@mcpjam/sdk/widget-runtime";
import { pluginResourceLinkModelText } from "./plugin-resource-link.js";

export const PLUGIN_MENTION_PART = "data-plugin-mention";
export { PLUGIN_MENTION_CONTEXT_LABEL } from "./plugin-resource-link.js";
export class PluginMentionError extends Error {}
export const pluginMentionQuerySchema = z.strictObject({
  query: z.string().max(1024),
});
export const pluginMentionSelectionSchema = z.strictObject({
  serverId: z.string().min(1).max(256),
  toolName: z.string().min(1).max(256),
  item: OpenAIMentionSearchResultSchema.shape.items.element,
});
export type PluginMentionSelection = z.infer<
  typeof pluginMentionSelectionSchema
>;
export function parsePluginMentionSelections(value: unknown) {
  const selections = z.array(pluginMentionSelectionSchema).max(64).parse(value);
  if (
    new TextEncoder().encode(JSON.stringify(selections)).byteLength >
    256 * 1024
  )
    throw new PluginMentionError("PLUGIN_MENTION_SELECTION_TOO_LARGE");
  return structuredClone(selections);
}

/** A mention tool declares `_meta["openai/extensions"]["mentions/search"]` as
 * an object (any fields; future ones are ignored) and must be visible to Apps.
 * A tool with no `ui.visibility` has the MCP Apps default ["model", "app"]. */
export function isPluginMentionTool(tool: { _meta?: Record<string, unknown> }) {
  const extensions = tool._meta?.["openai/extensions"];
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions))
    return false;
  const declaration = (extensions as Record<string, unknown>)[
    "mentions/search"
  ];
  if (
    !declaration ||
    typeof declaration !== "object" ||
    Array.isArray(declaration)
  )
    return false;
  const ui = tool._meta?.ui;
  if (ui !== undefined && (!ui || typeof ui !== "object" || Array.isArray(ui)))
    return false;
  const visibility = (ui as Record<string, unknown> | undefined)?.visibility;
  if (visibility === undefined) return true;
  return Array.isArray(visibility) && visibility.includes("app");
}

/** True when a mention tool relies on the default visibility (worth a hint
 * in the Logs panel: declare `ui.visibility` explicitly). */
export function pluginMentionToolUsesDefaultVisibility(tool: {
  _meta?: Record<string, unknown>;
}) {
  const ui = tool._meta?.ui;
  return (
    isPluginMentionTool(tool) &&
    (ui === undefined ||
      (ui as Record<string, unknown>).visibility === undefined)
  );
}

/** Preserve the official resource/link union. URIs remain data, never fetch grants. */
export function parsePluginMentionItems(result: unknown) {
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 256 * 1024)
    throw new PluginMentionError("PLUGIN_MENTION_RESULT_TOO_LARGE");
  const call = mcpAppToolResultSchema.parse(result);
  if (call.isError)
    throw new PluginMentionError("PLUGIN_MENTION_SEARCH_FAILED");
  const parsed = OpenAIMentionSearchResultSchema.parse(call.structuredContent);
  if (parsed.items.length > 128)
    throw new PluginMentionError("PLUGIN_MENTION_RESULT_TOO_LARGE");
  return structuredClone(parsed.items);
}

export function pluginMentionLink(selection: PluginMentionSelection) {
  const { item } = pluginMentionSelectionSchema.parse(selection);
  return item.type === "resource_link"
    ? structuredClone(item)
    : {
        type: "resource_link" as const,
        uri: item.resourceUri,
        name: item.title,
        title: item.title,
        ...(item.subtitle ? { description: item.subtitle } : {}),
        ...(item.icons ? { icons: structuredClone(item.icons) } : {}),
      };
}

/** Explicit text fallback for engines without a typed resource-link input. */
export function pluginMentionModelText(value: unknown): string {
  const selection = pluginMentionSelectionSchema.parse(value);
  if (
    new TextEncoder().encode(JSON.stringify(selection)).byteLength >
    256 * 1024
  )
    throw new PluginMentionError("PLUGIN_MENTION_RESULT_TOO_LARGE");
  return pluginResourceLinkModelText(pluginMentionLink(selection), "mention");
}

/** Query at the caret; selection replaces only this token, preserving surrounding text. */
export function pluginMentionToken(text: string, caret: number) {
  if (!Number.isSafeInteger(caret) || caret < 0 || caret > text.length) return;
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match || match[1]!.length > 1024) return;
  return { start: caret - match[1]!.length - 1, end: caret, query: match[1]! };
}
