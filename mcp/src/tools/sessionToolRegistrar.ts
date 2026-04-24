import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import type {
  McpServer,
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
  setUiEnabled(enabled: boolean): void;
}

export function createSessionToolRegistrar(server: McpServer): SessionToolRegistrar {
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

      const tool = registerAppTool(
        server,
        name,
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

      registerAppResource(
        server,
        ui.resourceName ?? `${config.title ?? name} UI`,
        ui.resourceUri,
        {
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
    setUiEnabled() {
      // The hosted example server always advertises its app tool and relies on
      // the host to ignore UI metadata when unsupported. Keep the method for
      // compatibility with existing call sites.
    },
  };
}
