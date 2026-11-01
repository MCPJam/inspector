import { z } from "zod";
import type { WidgetHost } from "@mcpjam/widget-react";
import type { ThreadAppHandle, createThreadAppApi } from "./thread-app-api";

const resourceResult = z
  .object({
    contents: z.array(
      z.union([
        z
          .object({
            uri: z.string(),
            mimeType: z.string().optional(),
            text: z.string(),
            _meta: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
        z
          .object({
            uri: z.string(),
            mimeType: z.string().optional(),
            blob: z.string(),
            _meta: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      ]),
    ),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const listing = z.object({
  resources: z.array(
    z
      .object({
        uri: z.string(),
        name: z.string(),
        description: z.string().optional(),
        mimeType: z.string().optional(),
      })
      .passthrough(),
  ),
  nextCursor: z.string().optional(),
});
const templates = z.object({
  resourceTemplates: z.array(
    z
      .object({
        uriTemplate: z.string(),
        name: z.string(),
        description: z.string().optional(),
        mimeType: z.string().optional(),
      })
      .passthrough(),
  ),
});

/** All reads use the original live instance, never the active account or client. */
type ResourceOperation = Parameters<
  ReturnType<typeof createThreadAppApi>["resource"]
>[1];

export function withModelAppResources(
  host: WidgetHost,
  base: WidgetHost,
  handle: ThreadAppHandle,
  serverId: string,
  api: Pick<ReturnType<typeof createThreadAppApi>, "resource">,
  signal: AbortSignal,
): WidgetHost {
  return withBoundAppResources(
    host,
    base,
    handle.resourcesEnabled === true,
    serverId,
    (operation, active) => api.resource(handle, operation, active),
    signal,
  );
}

export function withBoundAppResources(
  host: WidgetHost,
  base: WidgetHost,
  enabled: boolean,
  serverId: string,
  resource: (
    operation: ResourceOperation,
    active: AbortSignal,
  ) => Promise<Record<string, unknown>>,
  signal: AbortSignal,
): WidgetHost {
  const requireSource = (target: string) => {
    signal.throwIfAborted();
    if (!enabled || target !== serverId)
      throw new Error("App resource unavailable");
  };
  return {
    ...host,
    resolvers: {
      ...host.resolvers,
      resolveEffectiveHostCapabilities: (args) => ({
        ...host.resolvers.resolveEffectiveHostCapabilities(args),
        ...(enabled &&
        base.resolvers.resolveEffectiveHostCapabilities(args).serverResources
          ? {
              serverResources:
                base.resolvers.resolveEffectiveHostCapabilities(args)
                  .serverResources,
            }
          : {}),
      }),
      resolveEffectiveMcpAppsCapabilities: (args) => ({
        ...host.resolvers.resolveEffectiveMcpAppsCapabilities(args),
        serverResources:
          enabled === true &&
          base.resolvers.resolveEffectiveMcpAppsCapabilities(args)
            .serverResources,
      }),
    },
    services: {
      ...host.services,
      readResource: async (target, uri) => {
        requireSource(target);
        return {
          content: await resource({ method: "resources/read", uri }, signal),
        };
      },
      readResourceV2: async (params, extra) => {
        requireSource(serverId);
        const active = extra.signal
          ? AbortSignal.any([signal, extra.signal])
          : signal;
        return resourceResult.parse(
          await resource(
            {
              method: "resources/read",
              uri: params.uri,
              ...(params._meta ? { _meta: params._meta } : {}),
            },
            active,
          ),
        );
      },
      listResources: async (target, cursor) => {
        requireSource(target);
        return listing.parse(
          await resource(
            {
              method: "resources/list",
              ...(cursor !== undefined ? { cursor } : {}),
            },
            signal,
          ),
        );
      },
      listResourceTemplates: async (target) => {
        requireSource(target);
        return templates.parse(
          await resource({ method: "resources/templates/list" }, signal),
        ).resourceTemplates;
      },
    },
  };
}
