import { z } from "zod";
import {
  OpenAIUiToolMetadataSchema,
  type OpenAIUiEntrypoint,
} from "@openai/mcp-extensions/server";

export type PluginEntrypointTool = {
  name: string;
  title?: string;
  icons?: unknown;
  annotations?: { title?: string };
  _meta?: Record<string, unknown>;
};

/** Presentation scope. This selector supplies no actor, target or tool arguments. */
export const pluginEntrypointSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("settings") }),
  // A retry key, never a caller-selected target, arguments or execution ID.
  z.strictObject({
    kind: z.literal("quick-action"),
    requestId: z.string().uuid(),
  }),
  // Bytes and the resource binding are supplied separately by the host.
  z.strictObject({ kind: z.literal("file"), requestId: z.string().uuid() }),
  z.strictObject({
    kind: z.literal("thread"),
    threadId: z.string().min(1).max(256),
  }),
]);
export type PluginEntrypointSelector = z.infer<
  typeof pluginEntrypointSelectorSchema
>;
export class PluginActivationError extends Error {}

/** Catalog metadata is presentation, not a source of execution authority. */
export function pluginEntrypointDeclarations(tool: {
  _meta?: Record<string, unknown>;
}): OpenAIUiEntrypoint[] {
  const metadata = OpenAIUiToolMetadataSchema.safeParse(
    tool._meta?.["openai/ui"],
  );
  return metadata.success ? (metadata.data.entrypoints ?? []) : [];
}

export function pluginEntrypointTitle(tool: PluginEntrypointTool): string {
  return (
    [tool.title, tool.annotations?.title, tool.name].find(
      (value) => typeof value === "string" && value.trim().length > 0,
    ) ?? tool.name
  );
}

export function pluginEntrypointKinds(tool: {
  _meta?: Record<string, unknown>;
}): ("global" | "thread" | "settings")[] {
  return [
    ...new Set(
      pluginEntrypointDeclarations(tool).flatMap(({ type }) =>
        type === "global" || type === "thread" || type === "settings"
          ? [type]
          : [],
      ),
    ),
  ];
}

/** Ambiguous declarations are unavailable rather than arbitrarily selecting an effect. */
export function pluginQuickAction(tool: { _meta?: Record<string, unknown> }) {
  const actions = pluginEntrypointDeclarations(tool).flatMap((entrypoint) =>
    entrypoint.type === "global" && entrypoint.quickAction
      ? [entrypoint.quickAction]
      : [],
  );
  return actions.length === 1 ? structuredClone(actions[0]) : undefined;
}

/** Use only a single authorized server's catalog; names never cross servers. */
export function pluginSettingsEntrypoints(
  tools: readonly PluginEntrypointTool[],
  search = "",
) {
  const query = search.trim().toLocaleLowerCase();
  return tools.flatMap((tool) => {
    const declarations = pluginEntrypointDeclarations(tool).filter(
      (entrypoint) => entrypoint.type === "settings",
    );
    if (!declarations.length) return [];
    const title = pluginEntrypointTitle(tool);
    const searchTerms = [
      ...new Set(
        declarations.flatMap((entrypoint) => entrypoint.searchTerms ?? []),
      ),
    ];
    const matches = [title, tool.name, ...searchTerms].some((term) =>
      term.toLocaleLowerCase().includes(query),
    );
    return matches ? [{ toolName: tool.name, title, searchTerms }] : [];
  });
}

/** Declaration-only registry. A match does not grant access to a file. */
export function pluginFileEntrypoints(tools: readonly PluginEntrypointTool[]) {
  return tools.flatMap((tool) => {
    const extensions = [
      ...new Set(
        pluginEntrypointDeclarations(tool).flatMap((entrypoint) =>
          entrypoint.type === "file" ? entrypoint.extensions : [],
        ),
      ),
    ];
    return extensions.length
      ? [
          {
            toolName: tool.name,
            title: pluginEntrypointTitle(tool),
            extensions,
          },
        ]
      : [];
  });
}

/** Resolve only a declaration received from the authorized server's catalog. */
export function pluginEntrypointPlan(
  tool: { name: string; _meta?: Record<string, unknown> },
  selection: PluginEntrypointSelector,
) {
  const selector = pluginEntrypointSelectorSchema.parse(selection);
  if (selector.kind === "file")
    throw new PluginActivationError("PLUGIN_FILE_SOURCE_REQUIRED");
  if (selector.kind === "quick-action") {
    const action = pluginQuickAction(tool);
    if (!action)
      throw new PluginActivationError("PLUGIN_QUICK_ACTION_UNAVAILABLE");
    return {
      selector,
      params: {
        name: action.target.name,
        arguments: action.target.arguments ?? {},
      },
      scope: { kind: "global" as const },
    };
  }
  if (!pluginEntrypointKinds(tool).includes(selector.kind))
    throw new PluginActivationError("PLUGIN_ENTRYPOINT_UNAVAILABLE");
  return {
    selector,
    params: { name: tool.name, arguments: {} },
    scope:
      selector.kind === "thread"
        ? { kind: "thread" as const, threadId: selector.threadId }
        : { kind: "global" as const },
  };
}
