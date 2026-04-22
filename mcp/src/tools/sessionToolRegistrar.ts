import {
  RESOURCE_MIME_TYPE,
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

type ToolUiToggle = {
  setUiEnabled(enabled: boolean): void;
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
  setUiEnabled(enabled: boolean): void;
}

export function createSessionToolRegistrar(server: McpServer): SessionToolRegistrar {
  const uiToggles: ToolUiToggle[] = [];

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
      const plainTool = server.registerTool(name, config, callback);
      if (!ui) {
        return plainTool;
      }

      const hiddenPlainName = `${name}-text-fallback`;
      const hiddenUiName = `${name}-app-ui`;
      const uiTool = registerAppTool(
        server,
        hiddenUiName,
        {
          ...config,
          _meta: {
            ...(config._meta ?? {}),
            ui: {
              resourceUri: ui.resourceUri,
            },
          },
        } as any,
        (ui.callback ?? callback) as any
      );

      uiTool.disable();

      const resource = server.registerResource(
        ui.resourceName ?? `${config.title ?? name} UI`,
        ui.resourceUri,
        {
          mimeType: RESOURCE_MIME_TYPE,
          description:
            ui.resourceDescription ?? `${config.title ?? name} interactive UI`,
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

      resource.disable();

      uiToggles.push(
        createToolUiToggle({
          name,
          hiddenPlainName,
          hiddenUiName,
          plainTool,
          uiTool,
          resource,
        })
      );

      return plainTool;
    },
    setUiEnabled(enabled) {
      for (const toggle of uiToggles) {
        toggle.setUiEnabled(enabled);
      }
    },
  };
}

function createToolUiToggle({
  name,
  hiddenPlainName,
  hiddenUiName,
  plainTool,
  uiTool,
  resource,
}: {
  name: string;
  hiddenPlainName: string;
  hiddenUiName: string;
  plainTool: RegisteredTool;
  uiTool: RegisteredTool;
  resource: RegisteredResource;
}): ToolUiToggle {
  let uiEnabled = false;

  return {
    setUiEnabled(enabled) {
      if (enabled === uiEnabled) {
        return;
      }

      if (enabled) {
        plainTool.update({
          name: hiddenPlainName,
          enabled: false,
        });
        uiTool.update({
          name,
          enabled: true,
        });
        resource.enable();
      } else {
        uiTool.update({
          name: hiddenUiName,
          enabled: false,
        });
        plainTool.update({
          name,
          enabled: true,
        });
        resource.disable();
      }

      uiEnabled = enabled;
    },
  };
}
