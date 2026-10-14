import { z } from "zod";
import {
  OpenAIUiEntrypointSchema,
  type OpenAIUiEntrypoint,
} from "@openai/mcp-extensions/server";
import {
  pluginDiagnostic,
  type PluginDiagnostic,
} from "./plugin-diagnostics.js";

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

const entrypointListSchema = z.object({ entrypoints: z.array(z.unknown()) });

/** Catalog metadata is presentation, not a source of execution authority.
 * Each declaration is read on its own, so one this host does not recognize
 * (such as a removed kind) drops only itself, never the tool's other
 * entrypoints. */
function readEntrypoints(tool: { _meta?: Record<string, unknown> }) {
  const list = entrypointListSchema.safeParse(tool._meta?.["openai/ui"]);
  if (!list.success) return { entrypoints: [], ignored: 0 };
  const entrypoints = list.data.entrypoints.flatMap((entry) => {
    const parsed = OpenAIUiEntrypointSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  return {
    entrypoints,
    ignored: list.data.entrypoints.length - entrypoints.length,
  };
}

export function pluginEntrypointDeclarations(tool: {
  _meta?: Record<string, unknown>;
}): OpenAIUiEntrypoint[] {
  return readEntrypoints(tool).entrypoints;
}

/** One Logs row naming the tools whose unrecognized declarations were ignored. */
export function pluginEntrypointDiagnostics(
  tools: readonly { name: string; _meta?: Record<string, unknown> }[],
  serverId: string,
): PluginDiagnostic[] {
  const names = tools.flatMap((tool) =>
    readEntrypoints(tool).ignored ? [tool.name] : [],
  );
  if (!names.length) return [];
  return [
    {
      ...pluginDiagnostic(
        "warning",
        "PLUGIN_ENTRYPOINT_UNRECOGNIZED",
        "Entrypoint declaration ignored",
        'Some `_meta["openai/ui"].entrypoints` items are not a global, thread or file entrypoint (for example the removed `type: "settings"`), so MCPJam ignored them. The tools\' other entrypoints still work. Declare structured settings with the `openai/settings` server capability instead.',
        { tools: names.slice(0, 16) },
      ),
      serverId,
    },
  ];
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
}): ("global" | "thread")[] {
  return [
    ...new Set(
      pluginEntrypointDeclarations(tool).flatMap(({ type }) =>
        type === "global" || type === "thread" ? [type] : [],
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
  // A settings selector names MCPJam's structured-settings surface, which no
  // tool declares as an entrypoint.
  if (
    selector.kind === "settings" ||
    !pluginEntrypointKinds(tool).includes(selector.kind)
  )
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
