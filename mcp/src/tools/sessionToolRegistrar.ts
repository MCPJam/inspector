import {
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import type {
  McpServer,
  RegisteredResource,
  RegisteredTool,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AnySchema,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

type ToolConfig<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
> = {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
};

type ToolUiConfig<
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
> = {
  resourceUri: string;
  html: string;
  resourceName?: string;
  resourceDescription?: string;
  resourceMeta?: Record<string, unknown>;
  callback?: ToolCallback<InputArgs>;
};

export interface SessionToolRegistrar {
  registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
  >(
    name: string,
    config: ToolConfig<OutputArgs, InputArgs>,
    callback: ToolCallback<InputArgs>,
    ui?: ToolUiConfig<InputArgs>
  ): RegisteredTool;
  setUiEnabled(enabled: boolean, options?: SetUiEnabledOptions): void;
}

type SetUiEnabledOptions = {
  notify?: boolean;
};

type MutableRegisteredTool = RegisteredTool & {
  _meta?: Record<string, unknown>;
  enabled: boolean;
  handler: ToolCallback<any>;
};

type MutableRegisteredResource = RegisteredResource & {
  enabled: boolean;
};

type UiAwareRegistration = {
  plainCallback: ToolCallback<any>;
  plainMeta: Record<string, unknown> | undefined;
  resource: MutableRegisteredResource;
  tool: MutableRegisteredTool;
  uiCallback: ToolCallback<any>;
  uiMeta: Record<string, unknown>;
};

export function createSessionToolRegistrar(
  server: McpServer,
  uiEnabled: boolean
): SessionToolRegistrar {
  const uiAwareRegistrations: UiAwareRegistration[] = [];
  let currentUiEnabled = uiEnabled;

  return {
    registerTool<
      OutputArgs extends ZodRawShapeCompat | AnySchema,
      InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
    >(
      name: string,
      config: ToolConfig<OutputArgs, InputArgs>,
      callback: ToolCallback<InputArgs>,
      ui?: ToolUiConfig<InputArgs>
    ): RegisteredTool {
      if (!ui) {
        return server.registerTool(name, config, callback);
      }

      const plainMeta = stripToolUiMeta(config._meta);
      const uiMeta = createToolUiMeta(config._meta, ui.resourceUri);
      const uiCallback = (ui.callback ?? callback) as ToolCallback<any>;
      const tool = currentUiEnabled
        ? registerAppTool(
            server,
            name,
            {
              ...config,
              _meta: uiMeta,
            } as any,
            uiCallback as any
          )
        : server.registerTool(name, { ...config, _meta: plainMeta }, callback);

      const resource = server.registerResource(
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

      if (!currentUiEnabled) {
        resource.disable();
      }

      uiAwareRegistrations.push({
        plainCallback: callback as ToolCallback<any>,
        plainMeta,
        resource: resource as MutableRegisteredResource,
        tool: tool as MutableRegisteredTool,
        uiCallback,
        uiMeta,
      });

      return tool;
    },
    setUiEnabled(enabled, options) {
      if (currentUiEnabled === enabled) {
        return;
      }

      currentUiEnabled = enabled;
      const notify = options?.notify ?? true;

      for (const registration of uiAwareRegistrations) {
        applyUiEnabledState(registration, enabled, notify);
      }
    },
  };
}

function applyUiEnabledState(
  registration: UiAwareRegistration,
  enabled: boolean,
  notify: boolean
): void {
  if (notify) {
    registration.tool.update({
      _meta: enabled ? registration.uiMeta : (registration.plainMeta ?? {}),
      callback: enabled
        ? registration.uiCallback
        : registration.plainCallback,
    } as any);

    if (enabled) {
      registration.resource.enable();
    } else {
      registration.resource.disable();
    }

    return;
  }

  registration.tool._meta = enabled
    ? registration.uiMeta
    : (registration.plainMeta ?? {});
  registration.tool.handler = enabled
    ? registration.uiCallback
    : registration.plainCallback;
  registration.resource.enabled = enabled;
}

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
