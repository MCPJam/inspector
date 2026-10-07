import type { WidgetHost } from "@mcpjam/widget-react";
import type { HostBridgeCallbacks } from "@mcpjam/sdk/widget-runtime";
import { z } from "zod";
import { OpenAIResourceWriteResultSchema } from "@openai/mcp-extensions/app";
import {
  pluginFileWriteParamsSchema,
  pluginFileSubscriptionParamsSchema,
} from "@/shared/plugin-file";

type Extra = Parameters<
  NonNullable<HostBridgeCallbacks["onReadResourceV2"]>
>[1];

/** Vendor schemas stay in the app; the reusable renderer owns bridge lifetime. */
export function createFileResourceBridge(options: {
  uri: string;
  capabilities: { write: boolean; subscribe: boolean };
  requireLive: () => void;
  send: (
    method: "write-resource" | "subscribe-resource" | "unsubscribe-resource",
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}) {
  const deliveries = new Set<(uri: string) => Promise<void>>();
  const configureAppBridge: NonNullable<
    WidgetHost["services"]["configureAppBridge"]
  > = (bridge, capabilities) => {
    if (
      !capabilities.serverResources ||
      !capabilities.experimental?.["openai/resource"]
    )
      return;
    let live = true;
    const execute = async (
      method: Parameters<typeof options.send>[0],
      params: unknown,
      extra: Extra,
    ) => {
      options.requireLive();
      extra.signal.throwIfAborted();
      if (!live) throw new Error("File bridge closed");
      const result = await options.send(method, params, extra.signal);
      options.requireLive();
      extra.signal.throwIfAborted();
      if (!live) throw new Error("File bridge closed");
      return result;
    };
    if (options.capabilities.write)
      bridge.setRequestHandler(
        z.object({
          method: z.literal("openai/resources/write"),
          params: pluginFileWriteParamsSchema,
        }),
        async (request, extra) =>
          OpenAIResourceWriteResultSchema.parse(
            await execute("write-resource", request.params, extra),
          ),
      );
    if (options.capabilities.subscribe) {
      bridge.setRequestHandler(
        z.object({
          method: z.literal("resources/subscribe"),
          params: pluginFileSubscriptionParamsSchema,
        }),
        async (request, extra) => {
          await execute("subscribe-resource", request.params, extra);
          return {};
        },
      );
      bridge.setRequestHandler(
        z.object({
          method: z.literal("resources/unsubscribe"),
          params: pluginFileSubscriptionParamsSchema,
        }),
        async (request, extra) => {
          await execute("unsubscribe-resource", request.params, extra);
          return {};
        },
      );
    }
    const deliver = async (uri: string) => {
      if (!live || uri !== options.uri || !options.capabilities.subscribe)
        return;
      options.requireLive();
      // This pinned vendor notification extends ext-apps' closed notification
      // type. Use its explicit protocol shape rather than weakening core types.
      await (
        bridge as unknown as {
          notification(value: {
            method: "notifications/resources/updated";
            params: { uri: string };
          }): Promise<void>;
        }
      ).notification({
        method: "notifications/resources/updated",
        params: { uri },
      });
    };
    deliveries.add(deliver);
    return () => {
      live = false;
      deliveries.delete(deliver);
      if (options.capabilities.subscribe)
        void options
          .send("unsubscribe-resource", { uri: options.uri })
          .catch(() => {});
    };
  };
  return {
    configureAppBridge,
    resourceUpdated: async (uri: string) => {
      await Promise.all([...deliveries].map((deliver) => deliver(uri)));
    },
  };
}
