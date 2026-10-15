import {
  OPENAI_MENTIONS_CAPABILITY_KEY,
  OpenAIMentionsCapabilitySchema,
  OpenAIMentionSearchResultSchema,
} from "@openai/mcp-extensions/server";
import { z } from "zod";
import { mcpAppToolResultSchema } from "@mcpjam/sdk/widget-runtime";
import { pluginResourceLinkModelText } from "./plugin-resource-link.js";
import {
  pluginDiagnostic,
  type PluginDiagnostic,
} from "./plugin-diagnostics.js";

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

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Mention search must be visible to Apps. A tool with no `ui.visibility` has
 * the MCP Apps default ["model", "app"]. */
function visibleToApps(tool: { _meta?: Record<string, unknown> }) {
  const ui = tool._meta?.ui;
  if (ui !== undefined && !record(ui)) return false;
  const visibility = ui?.visibility;
  if (visibility === undefined) return true;
  return Array.isArray(visibility) && visibility.includes("app");
}

/** The deprecated per-tool declaration: `_meta["openai/extensions"]["mentions/search"]`
 * as an object (any fields; future ones are ignored), visible to Apps. It
 * counts only when the server has no `openai/mentions` capability. */
export function isPluginMentionTool(tool: { _meta?: Record<string, unknown> }) {
  const extensions = tool._meta?.["openai/extensions"];
  if (!record(extensions) || !record(extensions["mentions/search"]))
    return false;
  return visibleToApps(tool);
}

/** True when the mention tool relies on the default visibility (worth a hint
 * in the Logs panel: declare `ui.visibility` explicitly). */
export function pluginMentionToolUsesDefaultVisibility(tool: {
  _meta?: Record<string, unknown>;
}) {
  const ui = tool._meta?.ui;
  return ui === undefined || (record(ui) && ui.visibility === undefined);
}

/** The server's `openai/mentions` capability. Absent and malformed
 * declarations are distinct; 2026-07-28 discovery has no experimental
 * fallback, and a legacy server declaring both must name the same tool. */
export function pluginMentionsCapability(
  capabilities: unknown,
  transport: "legacy" | "mrtr",
) {
  if (!record(capabilities)) return undefined;
  const extensions = record(capabilities.extensions)
    ? capabilities.extensions
    : undefined;
  const experimental =
    transport === "legacy" && record(capabilities.experimental)
      ? capabilities.experimental
      : undefined;
  const declared = [extensions, experimental].flatMap((source) =>
    source && Object.hasOwn(source, OPENAI_MENTIONS_CAPABILITY_KEY)
      ? [source[OPENAI_MENTIONS_CAPABILITY_KEY]]
      : [],
  );
  if (!declared.length) return undefined;
  const names = declared.map((value) => {
    const parsed = OpenAIMentionsCapabilitySchema.safeParse(value);
    if (!parsed.success || parsed.data.searchTool.length > 256)
      throw new PluginMentionError("PLUGIN_MENTION_CAPABILITY_INVALID");
    return parsed.data.searchTool;
  });
  if (names.some((name) => name !== names[0]))
    throw new PluginMentionError("PLUGIN_MENTION_CAPABILITY_AMBIGUOUS");
  return { searchTool: names[0]! };
}

type MentionCandidate = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  _meta?: Record<string, unknown>;
};
type MentionServerFacts = {
  serverCapabilities?: unknown;
  transport?: "legacy" | "mrtr";
};

/** Why the capability's named tool can't serve mention search, if it can't. */
function searchToolProblem(tool: MentionCandidate | undefined) {
  if (!tool) return "PLUGIN_MENTION_SEARCH_TOOL_MISSING";
  if (tool.annotations?.readOnlyHint !== true)
    return "PLUGIN_MENTION_SEARCH_TOOL_NOT_READ_ONLY";
  if (!visibleToApps(tool)) return "PLUGIN_MENTION_SEARCH_TOOL_NOT_APP_VISIBLE";
  return undefined;
}

/** Plain-English causes for declarations MCPJam can't use, shown in Logs. */
const PLUGIN_MENTION_DECLARATION_PROBLEMS: Readonly<Record<string, string>> = {
  PLUGIN_MENTION_CAPABILITY_INVALID:
    'The server\'s openai/mentions capability is malformed. It must be { "searchTool": "<tool name>" } with a non-blank tool name.',
  PLUGIN_MENTION_CAPABILITY_AMBIGUOUS:
    "The server declares openai/mentions in both capabilities.extensions and capabilities.experimental with different search tools. Declare one tool.",
  PLUGIN_MENTION_SEARCH_TOOL_MISSING:
    "The server's openai/mentions capability names a search tool that isn't in its tools/list.",
  PLUGIN_MENTION_SEARCH_TOOL_NOT_READ_ONLY:
    "The mention search tool named by openai/mentions must set annotations.readOnlyHint to true.",
  PLUGIN_MENTION_SEARCH_TOOL_NOT_APP_VISIBLE:
    'The mention search tool named by openai/mentions must include "app" in _meta.ui.visibility.',
  PLUGIN_MENTION_DECLARATION_AMBIGUOUS:
    "More than one tool declares the deprecated mentions/search marker. Advertise the openai/mentions capability with one searchTool instead.",
};

/** The server's one mention search tool, or none. The `openai/mentions`
 * capability decides when present (its tool must be read-only and visible to
 * Apps); the deprecated tool declaration counts only without it. OpenAI's
 * helper declares both on the same tool, which is one tool, not two. A
 * declaration that can't be used yields no tool and one Logs diagnostic. */
export function pluginMentionSearchTool<T extends MentionCandidate>(
  catalog: MentionServerFacts & { tools: readonly T[] },
  serverId: string,
): { tool?: T; diagnostics: PluginDiagnostic[] } {
  const refuse = (code: string, details: Record<string, unknown> = {}) => ({
    diagnostics: [
      {
        ...pluginDiagnostic(
          "warning",
          code,
          "Mention search unavailable",
          PLUGIN_MENTION_DECLARATION_PROBLEMS[code] ?? code,
          details,
        ),
        serverId,
      },
    ],
  });
  let capability: { searchTool: string } | undefined;
  try {
    capability = pluginMentionsCapability(
      catalog.serverCapabilities,
      catalog.transport ?? "legacy",
    );
  } catch (error) {
    if (!(error instanceof PluginMentionError)) throw error;
    return refuse(error.message);
  }
  if (capability) {
    const tool = catalog.tools.find(
      (candidate) => candidate.name === capability.searchTool,
    );
    const problem = searchToolProblem(tool);
    return problem
      ? refuse(problem, { tool: capability.searchTool })
      : { tool, diagnostics: [] };
  }
  const tools = catalog.tools.filter(isPluginMentionTool);
  if (tools.length > 1)
    return refuse("PLUGIN_MENTION_DECLARATION_AMBIGUOUS", {
      tools: tools.slice(0, 16).map((tool) => tool.name),
    });
  return { tool: tools[0], diagnostics: [] };
}

/** Re-checks, on every request, that `tool` is still the server's mention
 * search tool under the same rule discovery used. */
export function isPluginMentionSearchTool(
  tool: MentionCandidate,
  server: MentionServerFacts,
) {
  const { tool: current } = pluginMentionSearchTool(
    { ...server, tools: [tool] },
    "",
  );
  return current?.name === tool.name;
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
