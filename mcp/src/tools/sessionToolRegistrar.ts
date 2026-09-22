/**
 * Thin registration helper over the v2 `McpServer`. One call registers a tool
 * and, for a widget-backed tool, its `ui://` MCP Apps resource plus the
 * `_meta` that points the host at it.
 *
 * Why there is no UI gating any more: the worker is stateless — a fresh
 * server is built per HTTP request, so a registration can never be re-shaped
 * once the client's `initialize` capabilities are known. A legacy-era
 * `tools/list` in particular arrives with no memory of the handshake at all.
 * The UI `_meta` is therefore ALWAYS advertised. That is a deliberate
 * deviation from SEP-1865's SHOULD (gate on the client's `ui` capability);
 * the accompanying MUST — a widget tool still returns a meaningful `content`
 * array — is unaffected, and `_meta.ui` is inert for hosts that do not render
 * apps. Always-on registration also fixes `resources/read` for the `ui://`
 * resources, which the old two-mode registrar disabled outright whenever UI
 * was not negotiated.
 */
import type {
  McpServer,
  RegisteredTool,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";
import {
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
} from "../shared/platform-widgets.js";

type ToolConfig<
  OutputArgs extends StandardSchemaWithJSON,
  InputArgs extends StandardSchemaWithJSON | undefined = undefined
> = {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

type ToolUiConfig<
  InputArgs extends StandardSchemaWithJSON | undefined = undefined
> = {
  resourceUri: string;
  html: string;
  resourceName?: string;
  resourceDescription?: string;
  resourceMeta?: Record<string, unknown>;
  /**
   * Widget-flavored callback. Registered in place of `callback` (the payload
   * it returns carries the `widget` tag the shared bundle routes on); the
   * plain callback remains the fallback for tools with no widget variant.
   */
  callback?: ToolCallback<InputArgs>;
};

export interface SessionToolRegistrar {
  registerTool<
    OutputArgs extends StandardSchemaWithJSON,
    InputArgs extends StandardSchemaWithJSON | undefined = undefined
  >(
    name: string,
    config: ToolConfig<OutputArgs, InputArgs>,
    callback: ToolCallback<InputArgs>,
    ui?: ToolUiConfig<InputArgs>
  ): RegisteredTool;
}

export function createSessionToolRegistrar(
  server: McpServer
): SessionToolRegistrar {
  return {
    registerTool<
      OutputArgs extends StandardSchemaWithJSON,
      InputArgs extends StandardSchemaWithJSON | undefined = undefined
    >(
      name: string,
      config: ToolConfig<OutputArgs, InputArgs>,
      callback: ToolCallback<InputArgs>,
      ui?: ToolUiConfig<InputArgs>
    ): RegisteredTool {
      if (!ui) {
        return server.registerTool(name, config, callback);
      }

      const tool = server.registerTool(
        name,
        { ...config, _meta: createToolUiMeta(config._meta, ui.resourceUri) },
        ui.callback ?? callback
      );

      server.registerResource(
        ui.resourceName ?? `${config.title ?? name} UI`,
        ui.resourceUri,
        {
          mimeType: RESOURCE_MIME_TYPE,
          description:
            ui.resourceDescription ?? `${config.title ?? name} interactive UI`,
          _meta: ui.resourceMeta,
        },
        async () => ({
          contents: [
            {
              uri: ui.resourceUri,
              mimeType: RESOURCE_MIME_TYPE,
              text: ui.html,
              _meta: ui.resourceMeta,
            },
          ],
        })
      );

      return tool;
    },
  };
}

/**
 * The MCP Apps tool `_meta`: the nested `ui.resourceUri` form preferred by
 * SEP-1865 plus the deprecated flat `ui/resourceUri` key, so hosts on either
 * form resolve the widget. This is exactly what `registerAppTool` from
 * `@modelcontextprotocol/ext-apps/server` used to synthesize, which is why the
 * worker no longer needs that (v1-SDK-typed) helper.
 */
function createToolUiMeta(
  meta: Record<string, unknown> | undefined,
  resourceUri: string
): Record<string, unknown> {
  const uiMeta =
    meta?.ui && typeof meta.ui === "object" && !Array.isArray(meta.ui)
      ? (meta.ui as Record<string, unknown>)
      : undefined;

  return {
    ...(stripToolUiMeta(meta) ?? {}),
    ui: {
      ...(uiMeta ?? {}),
      resourceUri,
    },
    [RESOURCE_URI_META_KEY]: resourceUri,
  };
}

function stripToolUiMeta(
  meta: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }

  const {
    [RESOURCE_URI_META_KEY]: _resourceUri,
    ui: _ui,
    ...plainMeta
  } = meta;

  return Object.keys(plainMeta).length > 0 ? plainMeta : undefined;
}
